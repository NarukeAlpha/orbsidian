import { app } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "./types";

export const APP_CONFIG_VERSION = 1;
export const EMBEDDED_OPENCODE_BASE_URL = "http://127.0.0.1:44096";

const LEGACY_LOCAL_OPENCODE_BASE_URLS = new Set([
  "",
  "http://127.0.0.1:4096",
  "http://localhost:4096"
]);

function normalizeOpenCodeBaseUrl(value: string | undefined): string {
  const normalized = String(value ?? "").trim();
  if (LEGACY_LOCAL_OPENCODE_BASE_URLS.has(normalized)) {
    return EMBEDDED_OPENCODE_BASE_URL;
  }
  return normalized || EMBEDDED_OPENCODE_BASE_URL;
}

export function getUserDataPath(): string {
  return app.getPath("userData");
}

export function getConfigPath(): string {
  return path.join(getUserDataPath(), "config.json");
}

export function getDataPath(): string {
  return path.join(getUserDataPath(), "data");
}

export function getModelsPath(): string {
  return path.join(getUserDataPath(), "models");
}

export function getRuntimeScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "runtime", "qwen_tts.py");
  }
  return path.join(app.getAppPath(), "runtime", "qwen_tts.py");
}

export async function ensureAppDirectories(): Promise<void> {
  await mkdir(getUserDataPath(), { recursive: true });
  await mkdir(getDataPath(), { recursive: true });
  await mkdir(getModelsPath(), { recursive: true });
}

export async function configExists(): Promise<boolean> {
  try {
    const details = await stat(getConfigPath());
    return details.isFile();
  } catch {
    return false;
  }
}

export function getDefaultConfig(): AppConfig {
  return {
    version: APP_CONFIG_VERSION,
    vaultPath: "",
    obsidianCliPath: "obsidian",
    hotkeys: {
      listen: "CommandOrControl+Shift+Space",
      ttsSkip: "CommandOrControl+Shift+]",
      ttsInterrupt: "CommandOrControl+Shift+\\"
    },
    stt: {
      binaryPath: "whisper-cli",
      modelPath: "",
      gpuMode: "auto",
      language: "auto",
      silenceMs: 3000,
      extraArgs: []
    },
    tts: {
      enabled: true,
      pythonPath: "python",
      modelPath: "",
      runtimeScriptPath: getRuntimeScriptPath(),
      speaker: "serena",
      language: "English",
      ack: true,
      done: true,
      readback: true,
      chunkChars: 420
    },
    opencode: {
      baseUrl: EMBEDDED_OPENCODE_BASE_URL,
      username: "",
      password: "",
      agent: "build",
      providerId: "",
      modelId: "",
      requestTimeoutMs: 180000
    },
    fallbackFileOpsEnabled: true,
    idleSessionExpiryMs: 30 * 60 * 1000,
    ui: {
      alwaysOnTop: true
    }
  };
}

export async function loadConfig(): Promise<AppConfig | null> {
  if (!(await configExists())) {
    return null;
  }
  const data = await readFile(getConfigPath(), "utf8");
  const parsed = JSON.parse(data) as AppConfig;
  return {
    ...getDefaultConfig(),
    ...parsed,
    hotkeys: { ...getDefaultConfig().hotkeys, ...(parsed.hotkeys ?? {}) },
    stt: { ...getDefaultConfig().stt, ...(parsed.stt ?? {}) },
    tts: { ...getDefaultConfig().tts, ...(parsed.tts ?? {}) },
    opencode: {
      ...getDefaultConfig().opencode,
      ...(parsed.opencode ?? {}),
      baseUrl: normalizeOpenCodeBaseUrl(parsed?.opencode?.baseUrl)
    },
    ui: { ...getDefaultConfig().ui, ...(parsed.ui ?? {}) }
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureAppDirectories();
  const next = {
    ...getDefaultConfig(),
    ...config,
    version: APP_CONFIG_VERSION
  };
  next.opencode = {
    ...getDefaultConfig().opencode,
    ...(next.opencode ?? {}),
    baseUrl: normalizeOpenCodeBaseUrl(next?.opencode?.baseUrl)
  };
  await writeFile(getConfigPath(), JSON.stringify(next, null, 2), "utf8");
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.vaultPath) {
    errors.push("Vault path is required.");
  }
  if (!config.obsidianCliPath) {
    errors.push("Obsidian CLI path is required.");
  }
  if (!config.stt.binaryPath) {
    errors.push("whisper.cpp binary path is required.");
  }
  if (!config.stt.modelPath) {
    errors.push("whisper.cpp model path is required.");
  }
  if (!config.opencode.baseUrl) {
    errors.push("OpenCode base URL is required.");
  }
  return errors;
}
