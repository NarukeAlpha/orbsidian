import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readdir, stat } from "node:fs/promises";
import {
  EMBEDDED_OPENCODE_BASE_URL,
  configExists,
  ensureAppDirectories,
  getDataPath,
  getDefaultConfig,
  getModelsPath,
  getRuntimeScriptPath,
  loadConfig,
  saveConfig,
  validateConfig
} from "./config";
import { AppDatabase } from "./db";
import { downloadQwenCustomVoiceModel, downloadWhisperBaseModel } from "./model-download";
import { probeObsidianCli, probeWhisperCli } from "./obsidian";
import { OpenCodeService } from "./opencode";
import { VoiceOrchestrator } from "./orchestrator";
import { WhisperService } from "./stt";
import { TtsService } from "./tts";
import { AppConfig, CaptureResult } from "./types";
import { execCommand } from "./utils";
import { autoSetupVoiceRuntime } from "./voice-runtime-setup";
import { resolveWhisperBinaryPath } from "./whisper-path";

function shouldOpenConfigFromArgv(argv: string[]): boolean {
  return argv.some((part) => {
    const normalized = part.toLowerCase();
    return normalized === "config" || normalized === "--config" || normalized === "-c";
  });
}

let orbWindow: BrowserWindow | null = null;
let wizardWindow: BrowserWindow | null = null;
let activityWindow: BrowserWindow | null = null;

let database: AppDatabase | null = null;
let orchestrator: VoiceOrchestrator | null = null;
let config: AppConfig | null = null;
let pendingOpenWizardFromSecondInstance = false;

let lastStatePayload: { state: string; label: string; queueDepth: number } = {
  state: "idle",
  label: "Idle",
  queueDepth: 0
};

const embeddedOpenCodeUrl = new URL(EMBEDDED_OPENCODE_BASE_URL);
const embeddedOpenCodeHost = embeddedOpenCodeUrl.hostname || "127.0.0.1";
const embeddedOpenCodePort = embeddedOpenCodeUrl.port || "44096";

let managedOpenCodeServerProcess: ReturnType<typeof spawn> | null = null;
let managedOpenCodeServerStartedByApp = false;
let managedOpenCodeServerStarting: Promise<void> | null = null;

interface RuntimePrecheckPayload {
  whisperBinaryPath?: string;
  whisperModelPath?: string;
  pythonPath?: string;
  qwenModelPath?: string;
  runtimeScriptPath?: string;
  modelsRoot?: string;
}

interface RuntimePrecheckResult {
  ready: boolean;
  whisperBinaryPath: string;
  whisperModelPath: string;
  pythonPath: string;
  qwenModelPath: string;
  missing: string[];
}

function rendererPath(fileName: string): string {
  return path.join(app.getAppPath(), "dist", "renderer", fileName);
}

function preloadPath(): string {
  return path.join(app.getAppPath(), "dist", "preload", "preload.js");
}

function createBaseWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({
    ...options,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      ...(options.webPreferences ?? {})
    }
  });
}

function createOrbWindow(): BrowserWindow {
  const window = createBaseWindow({
    width: 200,
    height: 210,
    frame: false,
    transparent: true,
    alwaysOnTop: config?.ui.alwaysOnTop ?? true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    title: "Orbsidian",
    backgroundColor: "#00000000"
  });
  void window.loadFile(rendererPath("orb.html"));
  window.on("closed", () => {
    orbWindow = null;
  });
  return window;
}

function createWizardWindow(): BrowserWindow {
  const window = createBaseWindow({
    width: 980,
    height: 760,
    frame: true,
    title: "Orbsidian Setup",
    resizable: true,
    minimizable: true,
    maximizable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121416" : "#f5f7fb"
  });
  void window.loadFile(rendererPath("wizard.html"));
  window.on("closed", () => {
    wizardWindow = null;
  });
  return window;
}

function openWizardWindow(): void {
  if (!wizardWindow || wizardWindow.isDestroyed()) {
    wizardWindow = createWizardWindow();
  }
  wizardWindow.show();
  wizardWindow.focus();
}

function createActivityWindow(): BrowserWindow {
  const window = createBaseWindow({
    width: 960,
    height: 680,
    frame: true,
    title: "Orbsidian Activity",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121416" : "#f5f7fb"
  });
  void window.loadFile(rendererPath("activity.html"));
  window.on("closed", () => {
    activityWindow = null;
  });
  return window;
}

function publishState(payload: { state: string; label: string; queueDepth: number }): void {
  lastStatePayload = payload;
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send("ui:state", payload);
  }
}

function publishActivityUpdated(): void {
  if (activityWindow && !activityWindow.isDestroyed()) {
    activityWindow.webContents.send("activity:updated");
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function isOpenCodeServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${EMBEDDED_OPENCODE_BASE_URL}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureManagedOpenCodeServerRunning(): Promise<void> {
  if (await isOpenCodeServerReachable()) {
    return;
  }

  if (!managedOpenCodeServerStarting) {
    managedOpenCodeServerStarting = (async () => {
      const logs: string[] = [];
      const processRef = spawn("opencode", ["serve", "--hostname", embeddedOpenCodeHost, "--port", embeddedOpenCodePort], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      managedOpenCodeServerProcess = processRef;
      managedOpenCodeServerStartedByApp = true;

      const pushLog = (chunk: Buffer): void => {
        const text = chunk.toString();
        if (!text.trim()) {
          return;
        }
        logs.push(text.trim());
        if (logs.length > 20) {
          logs.shift();
        }
      };

      processRef.stdout.on("data", pushLog);
      processRef.stderr.on("data", pushLog);

      let exited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let launchError: string | null = null;

      processRef.once("error", (error) => {
        exited = true;
        launchError = stringifyError(error);
        if (managedOpenCodeServerProcess === processRef) {
          managedOpenCodeServerProcess = null;
        }
      });

      processRef.once("exit", (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        if (managedOpenCodeServerProcess === processRef) {
          managedOpenCodeServerProcess = null;
        }
      });

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await isOpenCodeServerReachable()) {
          return;
        }

        if (exited) {
          break;
        }

        await delay(350);
      }

      const logTail = logs.length > 0 ? logs.join(" | ") : "No server logs were captured.";

      if (exited) {
        throw new Error(
          `OpenCode server failed to start on ${EMBEDDED_OPENCODE_BASE_URL} (${launchError ? `error=${launchError}` : `code=${String(
            exitCode
          )}, signal=${String(exitSignal)}`}). ${logTail}`
        );
      }

      throw new Error(`Timed out waiting for OpenCode server at ${EMBEDDED_OPENCODE_BASE_URL}. ${logTail}`);
    })()
      .catch((error) => {
        managedOpenCodeServerStartedByApp = false;
        throw error;
      })
      .finally(() => {
        managedOpenCodeServerStarting = null;
      });
  }

  await managedOpenCodeServerStarting;
}

async function stopManagedOpenCodeServer(): Promise<void> {
  if (!managedOpenCodeServerStartedByApp) {
    return;
  }

  const processRef = managedOpenCodeServerProcess;
  managedOpenCodeServerProcess = null;
  managedOpenCodeServerStartedByApp = false;

  if (!processRef || processRef.exitCode !== null) {
    return;
  }

  processRef.kill();
  await delay(800);

  if (processRef.exitCode === null && processRef.pid) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(processRef.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      await new Promise<void>((resolve) => {
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    } else {
      processRef.kill("SIGKILL");
      await delay(150);
    }
  }
}

async function precheckVoiceRuntime(payload: RuntimePrecheckPayload): Promise<RuntimePrecheckResult> {
  const userDataPath = app.getPath("userData");
  const modelsRoot = String(payload.modelsRoot ?? getModelsPath()).trim() || getModelsPath();
  const runtimeScriptPath = String(payload.runtimeScriptPath ?? getRuntimeScriptPath()).trim() || getRuntimeScriptPath();

  const defaultWhisperModelPath = path.join(modelsRoot, "whisper", "ggml-base.en.bin");
  const defaultQwenModelPath = path.join(modelsRoot, "qwen", "Qwen3-TTS-12Hz-1.7B-CustomVoice");
  const defaultPythonPath =
    process.platform === "win32"
      ? path.join(userDataPath, "tools", "qwen-tts-venv", "Scripts", "python.exe")
      : path.join(userDataPath, "tools", "qwen-tts-venv", "bin", "python");

  const preferredWhisper = String(payload.whisperBinaryPath ?? "").trim() || "whisper-cli";
  const whisperResolution = await resolveWhisperBinaryForPrecheck(preferredWhisper, userDataPath);

  const whisperModelPath =
    (await resolveFirstExistingFilePath([String(payload.whisperModelPath ?? "").trim(), defaultWhisperModelPath])) ??
    (String(payload.whisperModelPath ?? "").trim() || defaultWhisperModelPath);
  const whisperModelReady = await fileHasContent(whisperModelPath);

  const preferredPython = String(payload.pythonPath ?? "").trim();
  const pythonResolution = await resolvePythonForPrecheck(preferredPython, defaultPythonPath);

  const qwenModelPath =
    (await resolveFirstExistingQwenModelPath([String(payload.qwenModelPath ?? "").trim(), defaultQwenModelPath])) ??
    (String(payload.qwenModelPath ?? "").trim() || defaultQwenModelPath);
  const qwenModelReady = await directoryHasQwenModelArtifacts(qwenModelPath);

  const runtimeScriptReady = await pathExists(runtimeScriptPath, "file");

  const missing: string[] = [];
  if (!whisperResolution.ready) {
    missing.push("whisper.cpp binary");
  }
  if (!whisperModelReady) {
    missing.push("whisper.cpp model");
  }
  if (!pythonResolution.executableReady) {
    missing.push("Python executable");
  } else if (!pythonResolution.depsReady) {
    missing.push("Qwen TTS Python dependencies");
  }
  if (!qwenModelReady) {
    missing.push("Qwen model");
  }
  if (!runtimeScriptReady) {
    missing.push("Qwen runtime script");
  }

  return {
    ready: missing.length === 0,
    whisperBinaryPath: whisperResolution.path,
    whisperModelPath,
    pythonPath: pythonResolution.path,
    qwenModelPath,
    missing
  };
}

async function resolveWhisperBinaryForPrecheck(
  preferredBinaryPath: string,
  userDataPath: string
): Promise<{ path: string; ready: boolean }> {
  const preferredResolved = await resolveWhisperBinaryPath(preferredBinaryPath, userDataPath);
  if (await pathExists(preferredResolved, "file")) {
    return {
      path: preferredResolved,
      ready: true
    };
  }

  if (preferredBinaryPath && preferredBinaryPath !== "whisper-cli") {
    const probe = await probeWhisperCli(preferredBinaryPath);
    if (probe.ok) {
      return {
        path: preferredBinaryPath,
        ready: true
      };
    }
  }

  const fallbackResolved = await resolveWhisperBinaryPath("whisper-cli", userDataPath);
  if (await pathExists(fallbackResolved, "file")) {
    return {
      path: fallbackResolved,
      ready: true
    };
  }

  const fallbackProbe = await probeWhisperCli("whisper-cli");
  if (fallbackProbe.ok) {
    return {
      path: "whisper-cli",
      ready: true
    };
  }

  return {
    path: preferredBinaryPath || fallbackResolved || "whisper-cli",
    ready: false
  };
}

async function resolvePythonForPrecheck(
  preferredPythonPath: string,
  defaultPythonPath: string
): Promise<{ path: string; executableReady: boolean; depsReady: boolean }> {
  const candidates = [preferredPythonPath, defaultPythonPath, "python", "python3"];
  const seen = new Set<string>();

  let firstExecutablePath: string | null = null;
  for (const candidateRaw of candidates) {
    const candidate = candidateRaw.trim();
    if (!candidate) {
      continue;
    }

    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const executableReady = await pythonCommandWorks(candidate);
    if (!executableReady) {
      continue;
    }

    firstExecutablePath = firstExecutablePath ?? candidate;

    const depsReady = await pythonRuntimeDepsPresent(candidate);
    if (depsReady) {
      return {
        path: candidate,
        executableReady: true,
        depsReady: true
      };
    }
  }

  if (firstExecutablePath) {
    return {
      path: firstExecutablePath,
      executableReady: true,
      depsReady: false
    };
  }

  return {
    path: preferredPythonPath || defaultPythonPath || "python",
    executableReady: false,
    depsReady: false
  };
}

async function resolveFirstExistingFilePath(candidates: string[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidateRaw of candidates) {
    const candidate = candidateRaw.trim();
    if (!candidate) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (await fileHasContent(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveFirstExistingQwenModelPath(candidates: string[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidateRaw of candidates) {
    const candidate = candidateRaw.trim();
    if (!candidate) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (await directoryHasQwenModelArtifacts(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function pythonCommandWorks(command: string): Promise<boolean> {
  try {
    const result = await execCommand(command, ["--version"], { timeoutMs: 10000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function pythonRuntimeDepsPresent(command: string): Promise<boolean> {
  try {
    const result = await execCommand(command, ["-c", "import qwen_tts, soundfile"], { timeoutMs: 15000 });
    return result.code === 0;
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

async function pathExists(filePath: string, kind: "file" | "directory" | "any" = "any"): Promise<boolean> {
  try {
    const details = await stat(filePath);
    if (kind === "file") {
      return details.isFile();
    }
    if (kind === "directory") {
      return details.isDirectory();
    }
    return details.isFile() || details.isDirectory();
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
      const fullPath = path.join(dirPath, entry.name);
      const name = entry.name.toLowerCase();
      if (name.endsWith(".safetensors") || name === "tokenizer.json" || name === "tokenizer_config.json") {
        if (await fileHasContent(fullPath)) {
          return true;
        }
      }
    }

    const required = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"];
    for (const fileName of required) {
      if (await fileHasContent(path.join(dirPath, fileName))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function registerHotkeys(activeConfig: AppConfig): Promise<void> {
  globalShortcut.unregisterAll();

  const listenOk = globalShortcut.register(activeConfig.hotkeys.listen, () => {
    orchestrator?.handleListenHotkey();
  });

  const skipOk = globalShortcut.register(activeConfig.hotkeys.ttsSkip, () => {
    orchestrator?.handleTtsSkipHotkey();
  });

  const interruptOk = globalShortcut.register(activeConfig.hotkeys.ttsInterrupt, () => {
    orchestrator?.handleTtsInterruptHotkey();
  });

  if (!listenOk || !skipOk || !interruptOk) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Some global shortcuts could not be registered.",
      detail:
        "Please check for shortcut conflicts or platform permissions (especially Accessibility permissions on macOS)."
    });
  }
}

async function shutdownRuntime(reason: string): Promise<void> {
  globalShortcut.unregisterAll();
  await orchestrator?.cancelCurrentTransaction(reason);
  orchestrator?.dispose();
  orchestrator = null;
  database = null;
}

async function restartRuntime(activeConfig: AppConfig): Promise<void> {
  await shutdownRuntime("runtime_restart");
  await initializeRuntime(activeConfig);
}

async function initializeRuntime(activeConfig: AppConfig): Promise<void> {
  await ensureManagedOpenCodeServerRunning();
  await mkdir(getDataPath(), { recursive: true });

  database = new AppDatabase(getDataPath());
  await database.init();

  const openCode = new OpenCodeService(activeConfig);
  await openCode.connect();

  const whisper = new WhisperService(activeConfig);
  const tts = new TtsService(activeConfig, {
    onStatus: (label) => {
      publishState({
        state: "tts_playing",
        label,
        queueDepth: lastStatePayload.queueDepth
      });
    }
  });

  orchestrator = new VoiceOrchestrator({
    config: activeConfig,
    db: database,
    openCode,
    whisper,
    tts,
    callbacks: {
      onStateChanged: publishState,
      onCaptureCommand: (command) => {
        if (orbWindow && !orbWindow.isDestroyed()) {
          orbWindow.webContents.send("capture:command", command);
        }
      },
      onActivityRefresh: publishActivityUpdated
    }
  });

  await registerHotkeys(activeConfig);

  publishState({
    state: "idle",
    label: "Idle",
    queueDepth: 0
  });
}

function setupIpcHandlers(): void {
  ipcMain.handle("capture:result", async (_event, payload: CaptureResult) => {
    await orchestrator?.handleCaptureResult(payload);
    return { ok: true };
  });

  ipcMain.handle("transaction:cancel", async () => {
    await orchestrator?.cancelCurrentTransaction("manual_cancel");
    return { ok: true };
  });

  ipcMain.handle("activity:open", async () => {
    if (!activityWindow || activityWindow.isDestroyed()) {
      activityWindow = createActivityWindow();
    }
    activityWindow.show();
    activityWindow.focus();
    return { ok: true };
  });

  ipcMain.handle("activity:list", async (_event, limit = 300) => {
    if (!database) {
      return [];
    }
    return database.listEvents(Math.max(1, Math.min(1000, Number(limit) || 300)));
  });

  ipcMain.handle("permissions:mic", async () => {
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") {
        return { granted: true };
      }
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    }
    return { granted: true };
  });

  ipcMain.handle("wizard:open", async () => {
    openWizardWindow();
    return { ok: true };
  });

  ipcMain.handle("wizard:defaults", async () => {
    const defaults = config ?? (await loadConfig()) ?? getDefaultConfig();
    return {
      defaults,
      modelsRoot: getModelsPath(),
      runtimeScriptPath: getRuntimeScriptPath()
    };
  });

  ipcMain.handle("wizard:choose-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("wizard:probe-obsidian-cli", async (_event, binaryPath: string) => {
    return await probeObsidianCli(binaryPath);
  });

  ipcMain.handle("wizard:probe-whisper-cli", async (_event, binaryPath: string) => {
    return await probeWhisperCli(binaryPath);
  });

  ipcMain.handle("wizard:precheck-runtime", async (_event, payload: RuntimePrecheckPayload) => {
    return await precheckVoiceRuntime(payload ?? {});
  });

  ipcMain.handle("wizard:auto-setup-runtime", async () => {
    try {
      const result = await autoSetupVoiceRuntime({
        userDataPath: app.getPath("userData"),
        modelsRoot: getModelsPath(),
        onProgress: (progress) => {
          wizardWindow?.webContents.send("wizard:runtime-progress", progress);
        },
        onDownloadProgress: (progress) => {
          wizardWindow?.webContents.send("wizard:download-progress", progress);
        }
      });

      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const stage =
        typeof error === "object" && error !== null && "stage" in error
          ? String((error as { stage: unknown }).stage)
          : "runtime_setup";
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage,
        error: message
      };
    }
  });

  ipcMain.handle("wizard:download-whisper", async () => {
    const output = await downloadWhisperBaseModel(getModelsPath(), (progress) => {
      wizardWindow?.webContents.send("wizard:download-progress", progress);
    });
    return { ok: true, modelPath: output };
  });

  ipcMain.handle("wizard:download-qwen", async (_event, payload?: { pythonPath?: string }) => {
    const output = await downloadQwenCustomVoiceModel(
      getModelsPath(),
      (progress) => {
        wizardWindow?.webContents.send("wizard:download-progress", progress);
      },
      {
        pythonPath: payload?.pythonPath
      }
    );
    return { ok: true, modelPath: output };
  });

  ipcMain.handle("wizard:list-opencode-models", async (_event, payload: { baseUrl: string; username: string; password: string }) => {
    try {
      const current = getDefaultConfig();
      current.opencode.baseUrl = payload.baseUrl;
      current.opencode.username = payload.username ?? "";
      current.opencode.password = payload.password ?? "";
      const service = new OpenCodeService(current);
      await service.connect();
      const models = await service.listAvailableModels();
      return models;
    } catch (error) {
      return {
        ok: false,
        models: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle(
    "wizard:verify-opencode",
    async (_event, payload: { baseUrl: string; username: string; password: string }) => {
      try {
        const current = getDefaultConfig();
        current.opencode.baseUrl = payload.baseUrl;
        current.opencode.username = payload.username ?? "";
        current.opencode.password = payload.password ?? "";
        const service = new OpenCodeService(current);
        await service.connect();
        const health = await service.healthCheck();
        const modelsResult = await service.listAvailableModels();

        if (!health.ok && !modelsResult.ok) {
          const combinedErrors = Array.from(
            new Set([health.error, modelsResult.error].filter((value): value is string => Boolean(value)))
          );
          return {
            ok: false,
            error: combinedErrors.join(" | ") || "OpenCode verification failed"
          };
        }

        return {
          ok: true,
          version: health.version,
          healthError: health.ok ? undefined : health.error,
          models: modelsResult.ok ? modelsResult.models : [],
          defaultModel: modelsResult.ok ? modelsResult.defaultModel : undefined,
          modelListError: modelsResult.ok ? undefined : modelsResult.error
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );

  ipcMain.handle("wizard:save-config", async (_event, incomingConfig: AppConfig) => {
    const merged: AppConfig = {
      ...getDefaultConfig(),
      ...incomingConfig,
      hotkeys: {
        ...getDefaultConfig().hotkeys,
        ...(incomingConfig?.hotkeys ?? {})
      },
      stt: {
        ...getDefaultConfig().stt,
        ...(incomingConfig?.stt ?? {})
      },
      tts: {
        ...getDefaultConfig().tts,
        ...(incomingConfig?.tts ?? {}),
        runtimeScriptPath: incomingConfig?.tts?.runtimeScriptPath || getRuntimeScriptPath()
      },
      opencode: {
        ...getDefaultConfig().opencode,
        ...(incomingConfig?.opencode ?? {})
      },
      ui: {
        ...getDefaultConfig().ui,
        ...(incomingConfig?.ui ?? {})
      }
    };

    const validation = validateConfig(merged);
    if (validation.length > 0) {
      return {
        ok: false,
        errors: validation
      };
    }

    await saveConfig(merged);
    config = merged;

    if (!orbWindow || orbWindow.isDestroyed()) {
      orbWindow = createOrbWindow();
    }

    await restartRuntime(merged);

    if (wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.close();
      wizardWindow = null;
    }

    return { ok: true, errors: [] };
  });
}

async function bootstrap(): Promise<void> {
  await ensureAppDirectories();
  setupIpcHandlers();

  try {
    await ensureManagedOpenCodeServerRunning();
  } catch (error) {
    await dialog.showMessageBox({
      type: "warning",
      message: "OpenCode sidecar failed to start",
      detail: `${stringifyError(error)}\n\nYou can start it manually with: opencode serve --hostname ${embeddedOpenCodeHost} --port ${embeddedOpenCodePort}`
    });
  }

  const openConfigOnStart = shouldOpenConfigFromArgv(process.argv);

  const hasConfig = await configExists();
  if (!hasConfig) {
    openWizardWindow();
    return;
  }

  const loaded = await loadConfig();
  if (!loaded) {
    openWizardWindow();
    return;
  }

  config = loaded;
  orbWindow = createOrbWindow();
  if (openConfigOnStart) {
    openWizardWindow();
  }

  try {
    await initializeRuntime(loaded);
  } catch (error) {
    await dialog.showErrorBox(
      "Runtime initialization failed",
      error instanceof Error ? error.message : String(error)
    );
    openWizardWindow();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (shouldOpenConfigFromArgv(argv)) {
      if (app.isReady()) {
        openWizardWindow();
      } else {
        pendingOpenWizardFromSecondInstance = true;
      }
      return;
    }

    if (orbWindow && !orbWindow.isDestroyed()) {
      if (orbWindow.isMinimized()) {
        orbWindow.restore();
      }
      orbWindow.focus();
    }
  });

  app.whenReady().then(() => {
    void bootstrap().then(() => {
      if (pendingOpenWizardFromSecondInstance) {
        pendingOpenWizardFromSecondInstance = false;
        openWizardWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  await shutdownRuntime("app_exit");
  await stopManagedOpenCodeServer();
});

app.on("activate", () => {
  if (!orbWindow && config) {
    orbWindow = createOrbWindow();
  } else if (!wizardWindow && !config) {
    openWizardWindow();
  }
});
