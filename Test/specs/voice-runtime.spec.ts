import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

interface AppRuntimeConfig {
  stt?: {
    binaryPath?: string;
    modelPath?: string;
  };
  tts?: {
    pythonPath?: string;
    modelPath?: string;
    runtimeScriptPath?: string;
    speaker?: string;
    language?: string;
  };
}

interface RuntimeConfigSource {
  path: string;
  config: AppRuntimeConfig;
}

interface RuntimePaths {
  whisperBinaryPath: string;
  whisperModelPath: string;
  pythonPath: string;
  qwenModelPath: string;
  runtimeScriptPath: string;
  ttsSpeaker: string;
  ttsLanguage: string;
  configPath: string | null;
  modelsRootCandidates: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const QWEN_MODEL_DIR_NAME = "Qwen3-TTS-12Hz-1.7B-CustomVoice";
const DEFAULT_TTS_TEXT = "Voice runtime smoke test.";
const COMMAND_OUTPUT_MAX_CHARS = 6_000;

test.describe.configure({ mode: "serial" });

test("STT model is installed and whisper can serve transcription", async () => {
  const runtime = await resolveRuntimePaths();

  const whisperModelReady = await fileHasContent(runtime.whisperModelPath);
  expect(
    whisperModelReady,
    [
      `whisper model not found at: ${runtime.whisperModelPath}`,
      "Set ORBSIDIAN_STT_MODEL_PATH or ORBSIDIAN_MODELS_ROOT to your installed runtime.",
      formatRuntimeDiagnostics(runtime)
    ].join("\n")
  ).toBeTruthy();

  const helpResult = await runCommand(runtime.whisperBinaryPath, ["-h"], 20_000).catch((error) => {
    throw new Error(
      [
        `Could not execute whisper binary: ${runtime.whisperBinaryPath}`,
        String(error),
        "Set ORBSIDIAN_STT_BINARY_PATH if whisper-cli is not on PATH.",
        formatRuntimeDiagnostics(runtime)
      ].join("\n")
    );
  });

  expect(
    helpResult.code,
    formatCommandFailure(
      "Whisper help probe failed",
      runtime.whisperBinaryPath,
      ["-h"],
      helpResult,
      runtime
    )
  ).toBe(0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orbsidian-voice-stt-"));
  const inputPath = path.join(tempDir, "input.wav");
  const outputBase = path.join(tempDir, "output");
  const outputTxtPath = `${outputBase}.txt`;

  try {
    await writeFile(inputPath, createSineWaveWav());

    const transcriptionArgs = [
      "-m",
      runtime.whisperModelPath,
      "-f",
      inputPath,
      "-otxt",
      "-of",
      outputBase,
      "-np",
      "-l",
      "en"
    ];

    const transcriptionResult = await runCommand(runtime.whisperBinaryPath, transcriptionArgs, 120_000);

    expect(
      transcriptionResult.code,
      formatCommandFailure(
        "Whisper transcription smoke test failed",
        runtime.whisperBinaryPath,
        transcriptionArgs,
        transcriptionResult,
        runtime
      )
    ).toBe(0);

    const transcriptExists = await pathExists(outputTxtPath);
    expect(
      transcriptExists,
      [
        `whisper-cli completed but transcript file was not created: ${outputTxtPath}`,
        formatRuntimeDiagnostics(runtime)
      ].join("\n")
    ).toBeTruthy();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TTS model is installed and qwen runtime can generate audio", async () => {
  const runtime = await resolveRuntimePaths();

  const runtimeScriptExists = await fileExists(runtime.runtimeScriptPath);
  expect(
    runtimeScriptExists,
    [
      `Qwen runtime script not found at: ${runtime.runtimeScriptPath}`,
      "Set ORBSIDIAN_TTS_RUNTIME_SCRIPT_PATH to your qwen_tts.py location.",
      formatRuntimeDiagnostics(runtime)
    ].join("\n")
  ).toBeTruthy();

  const qwenModelReady = await directoryHasQwenModelArtifacts(runtime.qwenModelPath);
  expect(
    qwenModelReady,
    [
      `Qwen model artifacts not found at: ${runtime.qwenModelPath}`,
      "Set ORBSIDIAN_TTS_MODEL_PATH or ORBSIDIAN_MODELS_ROOT to your installed runtime.",
      formatRuntimeDiagnostics(runtime)
    ].join("\n")
  ).toBeTruthy();

  const pythonVersionResult = await runCommand(runtime.pythonPath, ["--version"], 20_000).catch((error) => {
    throw new Error(
      [
        `Could not execute Python command: ${runtime.pythonPath}`,
        String(error),
        "Set ORBSIDIAN_TTS_PYTHON_PATH if your runtime Python is not on PATH.",
        formatRuntimeDiagnostics(runtime)
      ].join("\n")
    );
  });

  expect(
    pythonVersionResult.code,
    formatCommandFailure(
      "Python version probe failed",
      runtime.pythonPath,
      ["--version"],
      pythonVersionResult,
      runtime
    )
  ).toBe(0);

  const depsCheckArgs = ["-c", "import qwen_tts, soundfile"];
  const depsCheckResult = await runCommand(runtime.pythonPath, depsCheckArgs, 40_000);
  expect(
    depsCheckResult.code,
    [
      formatCommandFailure("Qwen Python dependency probe failed", runtime.pythonPath, depsCheckArgs, depsCheckResult, runtime),
      "Try rerunning Auto Setup Voice Runtime to recreate the Python environment if dependencies are out of sync."
    ].join("\n")
  ).toBe(0);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orbsidian-voice-tts-"));
  const outputWavPath = path.join(tempDir, "tts-smoke.wav");
  const ttsArgs = [
    runtime.runtimeScriptPath,
    "--model-path",
    runtime.qwenModelPath,
    "--text",
    process.env.ORBSIDIAN_TTS_TEST_TEXT?.trim() || DEFAULT_TTS_TEXT,
    "--output",
    outputWavPath,
    "--speaker",
    runtime.ttsSpeaker,
    "--language",
    runtime.ttsLanguage,
    "--device",
    process.env.ORBSIDIAN_TTS_DEVICE?.trim() || "auto"
  ];

  try {
    const ttsResult = await runCommand(runtime.pythonPath, ttsArgs, 10 * 60_000);
    expect(
      ttsResult.code,
      formatCommandFailure("Qwen TTS generation smoke test failed", runtime.pythonPath, ttsArgs, ttsResult, runtime)
    ).toBe(0);

    const wavReady = await fileHasContent(outputWavPath);
    expect(
      wavReady,
      [
        `Qwen TTS completed but output WAV was not created: ${outputWavPath}`,
        formatRuntimeDiagnostics(runtime)
      ].join("\n")
    ).toBeTruthy();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function resolveRuntimePaths(): Promise<RuntimePaths> {
  const userDataCandidates = buildUserDataPathCandidates();
  const configPathCandidates = uniqueNonEmpty([
    normalizePath(process.env.ORBSIDIAN_CONFIG_PATH),
    ...userDataCandidates.map((root) => path.join(root, "config.json"))
  ]);
  const configSource = await loadRuntimeConfig(configPathCandidates);
  const config = configSource?.config ?? {};

  const modelsRootCandidates = uniqueNonEmpty([
    normalizePath(process.env.ORBSIDIAN_MODELS_ROOT),
    ...userDataCandidates.map((root) => path.join(root, "models"))
  ]);

  const whisperBinaryCandidates = userDataCandidates.flatMap((root) => {
    const fileName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    return [
      path.join(root, "tools", "whisper.cpp", "build", "bin", fileName),
      path.join(root, "tools", "whisper.cpp", "build", "bin", "Release", fileName)
    ];
  });

  const whisperBinaryPath = firstNonEmpty(
    normalizePath(process.env.ORBSIDIAN_STT_BINARY_PATH),
    normalizePath(config.stt?.binaryPath),
    await resolveExistingFilePath(whisperBinaryCandidates),
    "whisper-cli"
  );

  const whisperModelPath = firstNonEmpty(
    await resolveExistingFilePath([
      normalizePath(process.env.ORBSIDIAN_STT_MODEL_PATH),
      normalizePath(config.stt?.modelPath),
      ...modelsRootCandidates.map((root) => path.join(root, "whisper", "ggml-base.en.bin"))
    ]),
    normalizePath(process.env.ORBSIDIAN_STT_MODEL_PATH),
    normalizePath(config.stt?.modelPath),
    modelsRootCandidates[0] ? path.join(modelsRootCandidates[0], "whisper", "ggml-base.en.bin") : ""
  );

  const venvPythonCandidates = userDataCandidates.map((root) =>
    process.platform === "win32"
      ? path.join(root, "tools", "qwen-tts-venv", "Scripts", "python.exe")
      : path.join(root, "tools", "qwen-tts-venv", "bin", "python")
  );

  const pythonPath = firstNonEmpty(
    normalizePath(process.env.ORBSIDIAN_TTS_PYTHON_PATH),
    normalizePath(config.tts?.pythonPath),
    await resolveExistingFilePath(venvPythonCandidates),
    "python"
  );

  const qwenModelPath = firstNonEmpty(
    await resolveExistingQwenModelPath([
      normalizePath(process.env.ORBSIDIAN_TTS_MODEL_PATH),
      normalizePath(config.tts?.modelPath),
      ...modelsRootCandidates.map((root) => path.join(root, "qwen", QWEN_MODEL_DIR_NAME))
    ]),
    normalizePath(process.env.ORBSIDIAN_TTS_MODEL_PATH),
    normalizePath(config.tts?.modelPath),
    modelsRootCandidates[0] ? path.join(modelsRootCandidates[0], "qwen", QWEN_MODEL_DIR_NAME) : ""
  );

  const bundledRuntimeScript = path.resolve(process.cwd(), "runtime", "qwen_tts.py");
  const runtimeScriptPath = firstNonEmpty(
    normalizePath(process.env.ORBSIDIAN_TTS_RUNTIME_SCRIPT_PATH),
    (await fileExists(bundledRuntimeScript)) ? bundledRuntimeScript : "",
    normalizePath(config.tts?.runtimeScriptPath),
    bundledRuntimeScript
  );

  const ttsSpeaker = firstNonEmpty(process.env.ORBSIDIAN_TTS_SPEAKER, "serena");
  const ttsLanguage = firstNonEmpty(process.env.ORBSIDIAN_TTS_LANGUAGE, config.tts?.language, "English");

  return {
    whisperBinaryPath,
    whisperModelPath,
    pythonPath,
    qwenModelPath,
    runtimeScriptPath,
    ttsSpeaker,
    ttsLanguage,
    configPath: configSource?.path ?? null,
    modelsRootCandidates
  };
}

function buildUserDataPathCandidates(): string[] {
  const home = os.homedir();
  const appData = normalizePath(process.env.APPDATA);
  const localAppData = normalizePath(process.env.LOCALAPPDATA);
  const xdgConfigRoot = normalizePath(process.env.XDG_CONFIG_HOME) || path.join(home, ".config");

  return uniqueNonEmpty([
    normalizePath(process.env.ORBSIDIAN_USER_DATA_PATH),
    appData ? path.join(appData, "Orbsidian") : "",
    appData ? path.join(appData, "obsidian-agentic") : "",
    localAppData ? path.join(localAppData, "Orbsidian") : "",
    localAppData ? path.join(localAppData, "obsidian-agentic") : "",
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Orbsidian") : "",
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "obsidian-agentic") : "",
    process.platform !== "win32" ? path.join(xdgConfigRoot, "Orbsidian") : "",
    process.platform !== "win32" ? path.join(xdgConfigRoot, "obsidian-agentic") : ""
  ]);
}

async function loadRuntimeConfig(candidates: string[]): Promise<RuntimeConfigSource | null> {
  for (const candidate of candidates) {
    if (!(await fileHasContent(candidate))) {
      continue;
    }

    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as AppRuntimeConfig;
      return {
        path: candidate,
        config: parsed
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveExistingFilePath(candidates: Array<string | undefined>): Promise<string | null> {
  const uniqueCandidates = uniqueNonEmpty(candidates.map((candidate) => normalizePath(candidate)));
  for (const candidate of uniqueCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveExistingQwenModelPath(candidates: Array<string | undefined>): Promise<string | null> {
  const uniqueCandidates = uniqueNonEmpty(candidates.map((candidate) => normalizePath(candidate)));
  for (const candidate of uniqueCandidates) {
    if (await directoryHasQwenModelArtifacts(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (timedOut) {
        reject(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        return;
      }

      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr
      });
    });
  });
}

function formatCommandFailure(
  title: string,
  command: string,
  args: string[],
  result: CommandResult,
  runtime: RuntimePaths
): string {
  const stdout = truncate(stripAnsi(result.stdout).trim(), COMMAND_OUTPUT_MAX_CHARS);
  const stderr = truncate(stripAnsi(result.stderr).trim(), COMMAND_OUTPUT_MAX_CHARS);

  return [
    title,
    `Command: ${command} ${args.map(quoteArg).join(" ")}`,
    `Exit code: ${result.code}`,
    `stdout: ${stdout || "<empty>"}`,
    `stderr: ${stderr || "<empty>"}`,
    formatRuntimeDiagnostics(runtime)
  ].join("\n");
}

function formatRuntimeDiagnostics(runtime: RuntimePaths): string {
  const modelRoots = runtime.modelsRootCandidates.length > 0 ? runtime.modelsRootCandidates.join("; ") : "<none>";
  return [
    "Runtime path resolution:",
    `  config: ${runtime.configPath ?? "<not found>"}`,
    `  whisper binary: ${runtime.whisperBinaryPath}`,
    `  whisper model: ${runtime.whisperModelPath}`,
    `  python: ${runtime.pythonPath}`,
    `  qwen model: ${runtime.qwenModelPath}`,
    `  runtime script: ${runtime.runtimeScriptPath}`,
    `  model roots considered: ${modelRoots}`
  ].join("\n");
}

function createSineWaveWav(durationMs = 1400, sampleRate = 16_000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const sampleCount = Math.floor((durationMs / 1000) * sampleRate);
  const dataSize = sampleCount * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  let offset = 0;

  buffer.write("RIFF", offset, "ascii");
  offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  buffer.write("WAVE", offset, "ascii");
  offset += 4;
  buffer.write("fmt ", offset, "ascii");
  offset += 4;
  buffer.writeUInt32LE(16, offset);
  offset += 4;
  buffer.writeUInt16LE(1, offset);
  offset += 2;
  buffer.writeUInt16LE(channels, offset);
  offset += 2;
  buffer.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buffer.writeUInt32LE(byteRate, offset);
  offset += 4;
  buffer.writeUInt16LE(blockAlign, offset);
  offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset);
  offset += 2;
  buffer.write("data", offset, "ascii");
  offset += 4;
  buffer.writeUInt32LE(dataSize, offset);

  const amplitude = 0.22;
  const frequencyHz = 220;
  for (let index = 0; index < sampleCount; index += 1) {
    const raw = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
    const sample = Math.max(-1, Math.min(1, raw * amplitude));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }

  return buffer;
}

function quoteArg(value: string): string {
  if (/\s/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() || details.isDirectory();
  } catch {
    return false;
  }
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

async function directoryHasQwenModelArtifacts(dirPath: string): Promise<boolean> {
  try {
    const details = await stat(dirPath);
    if (!details.isDirectory()) {
      return false;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".safetensors") || lower === "tokenizer.json" || lower === "tokenizer_config.json") {
        if (await fileHasContent(path.join(dirPath, entry.name))) {
          return true;
        }
      }
    }

    const requiredCandidates = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"];
    for (const name of requiredCandidates) {
      if (await fileHasContent(path.join(dirPath, name))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    const normalized = normalizePath(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizePath(value: string | undefined | null): string {
  return String(value ?? "").trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const candidate = normalizePath(raw);
    if (!candidate) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(candidate);
  }

  return output;
}
