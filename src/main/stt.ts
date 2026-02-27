import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppConfig } from "./types";
import { randomId } from "./utils";

export interface TranscriptionResult {
  text: string;
  usedGpu: boolean;
}

export class WhisperService {
  private config: AppConfig;
  private currentChild: ReturnType<typeof spawn> | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  cancel(): void {
    if (this.currentChild) {
      this.currentChild.kill("SIGTERM");
      this.currentChild = null;
    }
  }

  async transcribeBase64Wav(audioBase64: string): Promise<TranscriptionResult> {
    const tempDir = path.join(os.tmpdir(), "orbidian-stt");
    await mkdir(tempDir, { recursive: true });

    const fileId = randomId("stt");
    const inputPath = path.join(tempDir, `${fileId}.wav`);
    const outputBase = path.join(tempDir, `${fileId}-out`);
    const outputTxt = `${outputBase}.txt`;

    await writeFile(inputPath, Buffer.from(audioBase64, "base64"));

    const shouldTryGpu = this.config.stt.gpuMode !== "cpu";

    try {
      const gpuAttempt = shouldTryGpu
        ? await this.runWhisper({ inputPath, outputBase, outputTxt, useGpuFlag: true })
        : { code: 1, stderr: "gpu disabled", stdout: "", usedGpu: false };

      if (gpuAttempt.code === 0) {
        const text = await this.readTranscript(outputTxt);
        return { text, usedGpu: true };
      }

      if (this.config.stt.gpuMode === "gpu") {
        throw new Error(gpuAttempt.stderr || "GPU transcription failed.");
      }

      const cpuAttempt = await this.runWhisper({ inputPath, outputBase, outputTxt, useGpuFlag: false });
      if (cpuAttempt.code !== 0) {
        throw new Error(cpuAttempt.stderr || "whisper.cpp transcription failed.");
      }

      const text = await this.readTranscript(outputTxt);
      return { text, usedGpu: false };
    } finally {
      await Promise.allSettled([rm(inputPath, { force: true }), rm(outputTxt, { force: true })]);
    }
  }

  private async runWhisper(params: {
    inputPath: string;
    outputBase: string;
    outputTxt: string;
    useGpuFlag: boolean;
  }): Promise<{ code: number; stdout: string; stderr: string; usedGpu: boolean }> {
    await rm(params.outputTxt, { force: true });

    const args = ["-m", this.config.stt.modelPath, "-f", params.inputPath, "-otxt", "-of", params.outputBase, "-np"];

    if (this.config.stt.language && this.config.stt.language !== "auto") {
      args.push("-l", this.config.stt.language);
    }

    if (params.useGpuFlag) {
      args.push("-ngl", "99");
    }

    for (const extraArg of this.config.stt.extraArgs) {
      args.push(extraArg);
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(this.config.stt.binaryPath, args, {
        windowsHide: true,
        shell: false
      });
      this.currentChild = child;

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        this.currentChild = null;
        reject(error);
      });

      child.on("close", (code) => {
        this.currentChild = null;
        resolve({
          code: typeof code === "number" ? code : 1,
          stdout,
          stderr,
          usedGpu: params.useGpuFlag
        });
      });
    });
  }

  private async readTranscript(outputTxtPath: string): Promise<string> {
    const text = await readFile(outputTxtPath, "utf8");
    return text.trim();
  }
}
