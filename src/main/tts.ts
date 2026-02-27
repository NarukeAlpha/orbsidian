import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppConfig } from "./types";
import { randomId, splitIntoChunks } from "./utils";

export interface TtsCallbacks {
  onStatus: (label: string) => void;
}

export class TtsService {
  private config: AppConfig;
  private callbacks: TtsCallbacks;
  private currentGeneration: ReturnType<typeof spawn> | null = null;
  private currentPlayback: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private skipRequested = false;
  private interruptRequested = false;

  constructor(config: AppConfig, callbacks: TtsCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  isBusy(): boolean {
    return this.busy;
  }

  skipCurrentChunk(): void {
    this.skipRequested = true;
    if (this.currentPlayback) {
      this.currentPlayback.kill("SIGTERM");
    }
  }

  interruptAll(): void {
    this.interruptRequested = true;
    if (this.currentGeneration) {
      this.currentGeneration.kill("SIGTERM");
    }
    if (this.currentPlayback) {
      this.currentPlayback.kill("SIGTERM");
    }
  }

  async speakAck(text: string): Promise<void> {
    if (!this.config.tts.enabled || !this.config.tts.ack) {
      return;
    }
    await this.speakText(text, false);
  }

  async speakDone(text: string): Promise<void> {
    if (!this.config.tts.enabled || !this.config.tts.done) {
      return;
    }
    await this.speakText(text, false);
  }

  async speakQuestion(text: string): Promise<void> {
    if (!this.config.tts.enabled) {
      return;
    }
    await this.speakText(text, false);
  }

  async speakReadback(text: string): Promise<{ interrupted: boolean; skippedLastChunk: boolean }> {
    if (!this.config.tts.enabled || !this.config.tts.readback) {
      return { interrupted: false, skippedLastChunk: false };
    }
    return this.speakText(text, true);
  }

  private async speakText(
    text: string,
    chunked: boolean
  ): Promise<{ interrupted: boolean; skippedLastChunk: boolean }> {
    const clean = text.trim();
    if (!clean) {
      return { interrupted: false, skippedLastChunk: false };
    }

    this.busy = true;
    this.skipRequested = false;
    this.interruptRequested = false;

    const chunks = chunked ? splitIntoChunks(clean, this.config.tts.chunkChars) : [clean];
    let skippedLastChunk = false;

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        this.callbacks.onStatus(`Speaking ${index + 1}/${chunks.length}`);

        const wavPath = await this.generateChunkAudio(chunk);
        try {
          const playbackResult = await this.playAudioFile(wavPath);
          if (this.interruptRequested) {
            return { interrupted: true, skippedLastChunk };
          }

          if (playbackResult === "skipped") {
            skippedLastChunk = index === chunks.length - 1;
            continue;
          }
        } finally {
          await rm(wavPath, { force: true });
        }
      }

      return { interrupted: false, skippedLastChunk };
    } finally {
      this.currentGeneration = null;
      this.currentPlayback = null;
      this.busy = false;
      this.skipRequested = false;
      this.interruptRequested = false;
      this.callbacks.onStatus("Idle");
    }
  }

  private async generateChunkAudio(text: string): Promise<string> {
    const tempDir = path.join(os.tmpdir(), "orbsidian-tts");
    await mkdir(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `${randomId("tts")}.wav`);

    const args = [
      this.config.tts.runtimeScriptPath,
      "--model-path",
      this.config.tts.modelPath,
      "--text",
      text,
      "--output",
      outputPath,
      "--speaker",
      this.config.tts.speaker,
      "--language",
      this.config.tts.language,
      "--device",
      "auto"
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.tts.pythonPath, args, {
        windowsHide: true,
        shell: false
      });
      this.currentGeneration = child;

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        this.currentGeneration = null;
        reject(error);
      });

      child.on("close", (code) => {
        this.currentGeneration = null;
        if (this.interruptRequested) {
          reject(new Error("tts interrupted"));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `TTS generation failed with code ${code ?? 1}`));
      });
    });

    return outputPath;
  }

  private async playAudioFile(filePath: string): Promise<"ended" | "skipped"> {
    return await new Promise((resolve, reject) => {
      const { command, args } = this.getPlaybackCommand(filePath);
      const child = spawn(command, args, {
        windowsHide: true,
        shell: false
      });
      this.currentPlayback = child;

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        this.currentPlayback = null;
        reject(error);
      });

      child.on("close", (code) => {
        this.currentPlayback = null;
        if (this.interruptRequested) {
          resolve("ended");
          return;
        }

        if (this.skipRequested) {
          this.skipRequested = false;
          resolve("skipped");
          return;
        }

        if (code === 0 || code === null) {
          resolve("ended");
          return;
        }

        reject(new Error(stderr || "Audio playback failed."));
      });
    });
  }

  private getPlaybackCommand(filePath: string): { command: string; args: string[] } {
    if (process.platform === "darwin") {
      return {
        command: "afplay",
        args: [filePath]
      };
    }

    if (process.platform === "win32") {
      return {
        command: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`
        ]
      };
    }

    return {
      command: "ffplay",
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath]
    };
  }
}
