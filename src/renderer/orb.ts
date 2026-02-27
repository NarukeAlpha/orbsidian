export {};

type CaptureCommand = {
  action: "start" | "stop";
  mode: "request" | "confirmation";
  silenceMs: number;
};

type OrbApi = {
  orb: {
    onCaptureCommand: (listener: (command: CaptureCommand) => void) => () => void;
    onState: (listener: (payload: { state: string; label: string; queueDepth: number }) => void) => () => void;
    sendCaptureResult: (payload: {
      audioBase64: string;
      hasSpeech: boolean;
      durationMs: number;
      mode: "request" | "confirmation";
    }) => Promise<{ ok: boolean }>;
    cancelTransaction: () => Promise<{ ok: boolean }>;
    openActivityPanel: () => Promise<{ ok: boolean }>;
    requestMicPermission: () => Promise<{ granted: boolean }>;
  };
};

const appApi = (window as any).orbidian as OrbApi;

class MicRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private hasSpeech = false;
  private lastSpeechAtMs = 0;
  private startedAtMs = 0;
  private mode: "request" | "confirmation" = "request";
  private silenceMs = 3000;
  private silenceTimer: number | null = null;
  private outputSampleRate = 16000;

  async start(command: CaptureCommand): Promise<void> {
    await this.stop(false);

    this.mode = command.mode;
    this.silenceMs = command.silenceMs;
    this.chunks = [];
    this.hasSpeech = false;
    this.lastSpeechAtMs = Date.now();
    this.startedAtMs = Date.now();

    const permission = await appApi.orb.requestMicPermission();
    if (!permission.granted) {
      await appApi.orb.sendCaptureResult({
        audioBase64: "",
        hasSpeech: false,
        durationMs: 0,
        mode: this.mode
      });
      return;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.context = new AudioContext();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);

      let sum = 0;
      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index];
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / input.length);
      if (rms >= 0.015) {
        this.hasSpeech = true;
        this.lastSpeechAtMs = Date.now();
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);

    this.silenceTimer = window.setInterval(async () => {
      const now = Date.now();
      const elapsedSinceSpeech = now - this.lastSpeechAtMs;
      const elapsedSinceStart = now - this.startedAtMs;

      if (this.hasSpeech && elapsedSinceSpeech >= this.silenceMs) {
        await this.stop(true);
        return;
      }

      if (!this.hasSpeech && elapsedSinceStart >= this.silenceMs) {
        await this.stop(true);
      }
    }, 150);
  }

  async stop(sendResult: boolean): Promise<void> {
    if (!this.context && !this.stream) {
      return;
    }

    if (this.silenceTimer) {
      window.clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    const durationMs = Date.now() - this.startedAtMs;

    this.processor?.disconnect();
    this.source?.disconnect();

    this.stream?.getTracks().forEach((track) => track.stop());

    const inputSampleRate = this.context?.sampleRate ?? 16000;

    await this.context?.close();

    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;

    if (!sendResult) {
      this.chunks = [];
      this.hasSpeech = false;
      return;
    }

    if (!this.hasSpeech || this.chunks.length === 0) {
      await appApi.orb.sendCaptureResult({
        audioBase64: "",
        hasSpeech: false,
        durationMs,
        mode: this.mode
      });
      this.chunks = [];
      this.hasSpeech = false;
      return;
    }

    const merged = this.mergeChunks(this.chunks);
    const downsampled = this.downsampleTo16k(merged, inputSampleRate);
    const wav = this.encodeWav(downsampled, this.outputSampleRate);
    const base64 = this.arrayBufferToBase64(wav.buffer);

    await appApi.orb.sendCaptureResult({
      audioBase64: base64,
      hasSpeech: this.hasSpeech,
      durationMs,
      mode: this.mode
    });

    this.chunks = [];
    this.hasSpeech = false;
  }

  private mergeChunks(chunks: Float32Array[]): Float32Array {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  private downsampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
    if (inputRate === this.outputSampleRate) {
      return samples;
    }

    const ratio = inputRate / this.outputSampleRate;
    const outputLength = Math.round(samples.length / ratio);
    const output = new Float32Array(outputLength);

    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < outputLength) {
      const nextInputIndex = Math.round((outputIndex + 1) * ratio);
      let sum = 0;
      let count = 0;
      while (inputIndex < nextInputIndex && inputIndex < samples.length) {
        sum += samples[inputIndex];
        count += 1;
        inputIndex += 1;
      }
      output[outputIndex] = count > 0 ? sum / count : 0;
      outputIndex += 1;
    }

    return output;
  }

  private encodeWav(samples: Float32Array, sampleRate: number): DataView {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return view;
  }

  private writeString(view: DataView, offset: number, text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  private arrayBufferToBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.byteLength; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }
}

const orbButton = document.getElementById("orbButton") as HTMLButtonElement;
const cancelButton = document.getElementById("cancelButton") as HTMLButtonElement;
const activityButton = document.getElementById("activityButton") as HTMLButtonElement;
const statusText = document.getElementById("statusText") as HTMLDivElement;
const queueText = document.getElementById("queueText") as HTMLDivElement;

const recorder = new MicRecorder();
let currentState = "idle";

appApi.orb.onState((payload) => {
  currentState = payload.state;
  statusText.textContent = payload.label;
  queueText.textContent = `Queue: ${payload.queueDepth}`;

  orbButton.className = `orb state-${payload.state}`;
  if (payload.state === "listening" || payload.state === "transcribing" || payload.state === "agent_running" || payload.state === "tts_playing" || payload.state === "executing") {
    orbButton.classList.add("spin");
  }
});

appApi.orb.onCaptureCommand(async (command) => {
  if (command.action === "start") {
    await recorder.start(command);
    return;
  }
  await recorder.stop(false);
});

orbButton.addEventListener("click", async () => {
  if (currentState !== "idle") {
    await appApi.orb.cancelTransaction();
  }
});

cancelButton.addEventListener("click", async () => {
  await appApi.orb.cancelTransaction();
});

activityButton.addEventListener("click", async () => {
  await appApi.orb.openActivityPanel();
});
