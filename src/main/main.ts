import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
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
import { autoSetupVoiceRuntime } from "./voice-runtime-setup";

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
    title: "Orbidian",
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
    title: "Orbidian Setup",
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
    title: "Orbidian Activity",
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

  ipcMain.handle("wizard:download-qwen", async () => {
    const output = await downloadQwenCustomVoiceModel(getModelsPath(), (progress) => {
      wizardWindow?.webContents.send("wizard:download-progress", progress);
    });
    return { ok: true, modelPath: output };
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
        return await service.healthCheck();
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
});

app.on("activate", () => {
  if (!orbWindow && config) {
    orbWindow = createOrbWindow();
  } else if (!wizardWindow && !config) {
    openWizardWindow();
  }
});
