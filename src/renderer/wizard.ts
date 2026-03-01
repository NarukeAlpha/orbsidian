export {};

type WizardApi = {
  wizard: {
    getDefaults: () => Promise<{
      defaults: any;
      modelsRoot: string;
      runtimeScriptPath: string;
    }>;
    chooseDirectory: () => Promise<{ canceled: boolean; path: string }>;
    probeObsidianCli: (binaryPath: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
    probeWhisperCli: (binaryPath: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
    precheckRuntime: (payload: {
      whisperBinaryPath?: string;
      whisperModelPath?: string;
      pythonPath?: string;
      qwenModelPath?: string;
      runtimeScriptPath?: string;
      modelsRoot?: string;
    }) => Promise<{
      ready: boolean;
      whisperBinaryPath: string;
      whisperModelPath: string;
      pythonPath: string;
      qwenModelPath: string;
      missing: string[];
    }>;
    autoSetupRuntime: () => Promise<{
      ok: boolean;
      whisperBinaryPath?: string;
      whisperModelPath?: string;
      pythonPath?: string;
      qwenModelPath?: string;
      stage?: string;
      error?: string;
    }>;
    downloadWhisperModel: () => Promise<{ ok: boolean; modelPath: string }>;
    downloadQwenModel: (payload?: { pythonPath?: string }) => Promise<{ ok: boolean; modelPath: string }>;
    verifyOpenCode: (payload: {
      baseUrl: string;
      username: string;
      password: string;
    }) => Promise<{
      ok: boolean;
      version?: string;
      error?: string;
      healthError?: string;
      models?: Array<{
        id: string;
        providerId: string;
        modelId: string;
        label: string;
      }>;
      defaultModel?: string;
      modelListError?: string;
    }>;
    saveConfig: (config: any) => Promise<{ ok: boolean; errors: string[] }>;
    onDownloadProgress: (
      listener: (payload: {
        stage: string;
        fileName: string;
        fileIndex: number;
        totalFiles: number;
        downloadedBytes: number;
        totalBytes: number;
      }) => void
    ) => () => void;
    onRuntimeProgress: (
      listener: (payload: {
        stage: string;
        message: string;
      }) => void
    ) => () => void;
  };
};

const appApi = (window as any).orbsidian as WizardApi;

const elements = {
  vaultPath: document.getElementById("vaultPath") as HTMLInputElement,
  obsidianCliPath: document.getElementById("obsidianCliPath") as HTMLInputElement,
  whisperBinaryPath: document.getElementById("whisperBinaryPath") as HTMLInputElement,
  whisperModelPath: document.getElementById("whisperModelPath") as HTMLInputElement,
  pythonPath: document.getElementById("pythonPath") as HTMLInputElement,
  qwenModelPath: document.getElementById("qwenModelPath") as HTMLInputElement,
  ttsSpeaker: document.getElementById("ttsSpeaker") as HTMLInputElement,
  ttsLanguage: document.getElementById("ttsLanguage") as HTMLInputElement,
  hotkeyListen: document.getElementById("hotkeyListen") as HTMLInputElement,
  hotkeySkip: document.getElementById("hotkeySkip") as HTMLInputElement,
  hotkeyInterrupt: document.getElementById("hotkeyInterrupt") as HTMLInputElement,
  ttsAck: document.getElementById("ttsAck") as HTMLInputElement,
  ttsDone: document.getElementById("ttsDone") as HTMLInputElement,
  ttsReadback: document.getElementById("ttsReadback") as HTMLInputElement,
  opencodeBaseUrl: document.getElementById("opencodeBaseUrl") as HTMLInputElement,
  opencodeUser: document.getElementById("opencodeUser") as HTMLInputElement,
  opencodePass: document.getElementById("opencodePass") as HTMLInputElement,
  opencodeAgent: document.getElementById("opencodeAgent") as HTMLInputElement,
  opencodeModelSelect: document.getElementById("opencodeModelSelect") as HTMLSelectElement,
  status: document.getElementById("status") as HTMLDivElement,
  obsidianTestMessage: document.getElementById("obsidianTestMessage") as HTMLDivElement,
  whisperTestMessage: document.getElementById("whisperTestMessage") as HTMLDivElement,
  runtimeMessage: document.getElementById("runtimeMessage") as HTMLDivElement,
  opencodeMessage: document.getElementById("opencodeMessage") as HTMLDivElement,
  opencodeModelMessage: document.getElementById("opencodeModelMessage") as HTMLDivElement,
  saveMessage: document.getElementById("saveMessage") as HTMLDivElement,
  browseVault: document.getElementById("browseVault") as HTMLButtonElement,
  testObsidian: document.getElementById("testObsidian") as HTMLButtonElement,
  testWhisper: document.getElementById("testWhisper") as HTMLButtonElement,
  downloadWhisper: document.getElementById("downloadWhisper") as HTMLButtonElement,
  downloadQwen: document.getElementById("downloadQwen") as HTMLButtonElement,
  verifyOpenCode: document.getElementById("verifyOpenCode") as HTMLButtonElement,
  saveConfig: document.getElementById("saveConfig") as HTMLButtonElement
};

const autoSetupRuntimeButton = document.getElementById("autoSetupRuntime") as HTMLButtonElement;

let runtimeReady = false;
let opencodeReady = false;
let preferredModelFromConfig = "";

function setStatus(message: string): void {
  elements.status.textContent = message;
  elements.status.style.color = "#364c5b";
}

function setInlineMessage(element: HTMLDivElement, message: string, tone: "default" | "error" | "success" = "default"): void {
  element.textContent = message;
  element.classList.remove("error", "success");
  if (tone === "error") {
    element.classList.add("error");
  }
  if (tone === "success") {
    element.classList.add("success");
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

function applyDefaults(defaults: any, runtimeScriptPath: string): void {
  elements.obsidianCliPath.value = defaults.obsidianCliPath || "obsidian";
  elements.whisperBinaryPath.value = defaults.stt.binaryPath || "whisper-cli";
  elements.whisperModelPath.value = defaults.stt.modelPath || "";
  elements.pythonPath.value = defaults.tts.pythonPath || "python";
  elements.qwenModelPath.value = defaults.tts.modelPath || "";
  elements.ttsSpeaker.value = defaults.tts.speaker || "serena";
  elements.ttsLanguage.value = defaults.tts.language || "English";
  elements.hotkeyListen.value = defaults.hotkeys.listen;
  elements.hotkeySkip.value = defaults.hotkeys.ttsSkip;
  elements.hotkeyInterrupt.value = defaults.hotkeys.ttsInterrupt;
  elements.ttsAck.checked = Boolean(defaults.tts.ack);
  elements.ttsDone.checked = Boolean(defaults.tts.done);
  elements.ttsReadback.checked = Boolean(defaults.tts.readback);
  elements.opencodeBaseUrl.value = defaults.opencode.baseUrl || "http://127.0.0.1:44096";
  elements.opencodeUser.value = defaults.opencode.username || "";
  elements.opencodePass.value = defaults.opencode.password || "";
  elements.opencodeAgent.value = defaults.opencode.agent || "build";
  const providerId = defaults.opencode.providerId || "";
  const modelId = defaults.opencode.modelId || "";
  preferredModelFromConfig = providerId && modelId ? `${providerId}/${modelId}` : "";
  elements.opencodeModelSelect.innerHTML = "";
  elements.opencodeModelSelect.append(new Option("Auto (server default)", ""));
  elements.opencodeModelSelect.value = "";

  if (!elements.qwenModelPath.value) {
    elements.qwenModelPath.placeholder = `${runtimeScriptPath.replace(/qwen_tts\.py$/, "")}/...`;
  }
}

function populateOpenCodeModels(models: Array<{ id: string; providerId: string; modelId: string; label: string }>): void {
  const previous = elements.opencodeModelSelect.value.trim();
  const explicitPreferred = previous || preferredModelFromConfig;

  elements.opencodeModelSelect.innerHTML = "";
  elements.opencodeModelSelect.append(new Option("Auto (server default)", ""));

  for (const model of models) {
    elements.opencodeModelSelect.append(new Option(model.label, model.id));
  }

  if (explicitPreferred && models.some((model) => model.id === explicitPreferred)) {
    elements.opencodeModelSelect.value = explicitPreferred;
  } else {
    elements.opencodeModelSelect.value = "";
  }
}

function buildConfig(runtimeScriptPath: string): any {
  const selectedModel = elements.opencodeModelSelect.value.trim();
  let providerId = "";
  let modelId = "";
  const slashIndex = selectedModel.indexOf("/");
  if (slashIndex > 0) {
    providerId = selectedModel.slice(0, slashIndex);
    modelId = selectedModel.slice(slashIndex + 1);
  }

  return {
    version: 1,
    vaultPath: elements.vaultPath.value.trim(),
    obsidianCliPath: elements.obsidianCliPath.value.trim(),
    hotkeys: {
      listen: elements.hotkeyListen.value.trim(),
      ttsSkip: elements.hotkeySkip.value.trim(),
      ttsInterrupt: elements.hotkeyInterrupt.value.trim()
    },
    stt: {
      binaryPath: elements.whisperBinaryPath.value.trim(),
      modelPath: elements.whisperModelPath.value.trim(),
      gpuMode: "auto",
      language: "auto",
      silenceMs: 3000,
      extraArgs: []
    },
    tts: {
      enabled: true,
      pythonPath: elements.pythonPath.value.trim(),
      modelPath: elements.qwenModelPath.value.trim(),
      runtimeScriptPath,
      speaker: elements.ttsSpeaker.value.trim() || "serena",
      language: elements.ttsLanguage.value.trim() || "English",
      ack: elements.ttsAck.checked,
      done: elements.ttsDone.checked,
      readback: elements.ttsReadback.checked,
      chunkChars: 420
    },
    opencode: {
      baseUrl: elements.opencodeBaseUrl.value.trim(),
      username: elements.opencodeUser.value.trim(),
      password: elements.opencodePass.value,
      agent: elements.opencodeAgent.value.trim() || "build",
      providerId,
      modelId,
      requestTimeoutMs: 180000
    },
    fallbackFileOpsEnabled: true,
    idleSessionExpiryMs: 30 * 60 * 1000,
    ui: {
      alwaysOnTop: true
    }
  };
}

async function init(): Promise<void> {
  const defaultsPayload = await appApi.wizard.getDefaults();
  applyDefaults(defaultsPayload.defaults, defaultsPayload.runtimeScriptPath);

  const unsubscribe = appApi.wizard.onDownloadProgress((progress) => {
    const pct = progress.totalBytes > 0 ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 100) : 0;
    setStatus(
      `${progress.stage}: ${progress.fileName} (${progress.fileIndex}/${progress.totalFiles}) ${pct}% ${formatBytes(
        progress.downloadedBytes
      )}/${formatBytes(progress.totalBytes)}`
    );
  });

  const unsubscribeRuntime = appApi.wizard.onRuntimeProgress((progress) => {
    setStatus(`[${progress.stage}] ${progress.message}`);
  });

  window.addEventListener("beforeunload", () => {
    unsubscribe();
    unsubscribeRuntime();
  });

  const runRuntimePrecheck = async (): Promise<void> => {
    setInlineMessage(elements.saveMessage, "", "default");
    autoSetupRuntimeButton.disabled = true;
    const previousLabel = autoSetupRuntimeButton.textContent ?? "Auto Setup Voice Runtime";
    autoSetupRuntimeButton.textContent = "Checking...";
    setStatus("Checking voice runtime...");

    try {
      const result = await appApi.wizard.precheckRuntime({
        whisperBinaryPath: elements.whisperBinaryPath.value.trim(),
        whisperModelPath: elements.whisperModelPath.value.trim(),
        pythonPath: elements.pythonPath.value.trim(),
        qwenModelPath: elements.qwenModelPath.value.trim(),
        runtimeScriptPath: defaultsPayload.runtimeScriptPath,
        modelsRoot: defaultsPayload.modelsRoot
      });

      if (result.whisperBinaryPath) {
        elements.whisperBinaryPath.value = result.whisperBinaryPath;
      }
      if (result.whisperModelPath) {
        elements.whisperModelPath.value = result.whisperModelPath;
      }
      if (result.pythonPath) {
        elements.pythonPath.value = result.pythonPath;
      }
      if (result.qwenModelPath) {
        elements.qwenModelPath.value = result.qwenModelPath;
      }

      runtimeReady = result.ready;
      if (result.ready) {
        setInlineMessage(elements.runtimeMessage, "Voice runtime is installed and ready.", "success");
        setStatus("Voice runtime detected. You can run tests and continue setup.");
      } else {
        const missingText = result.missing.length > 0 ? ` Missing: ${result.missing.join(", ")}.` : "";
        setInlineMessage(
          elements.runtimeMessage,
          `Voice runtime is not fully installed.${missingText} Click Auto Setup Voice Runtime to install missing components.`,
          "default"
        );
        setStatus("Voice runtime setup is required.");
      }
    } catch (error) {
      runtimeReady = false;
      setInlineMessage(elements.runtimeMessage, error instanceof Error ? error.message : String(error), "error");
      setStatus("Voice runtime precheck failed.");
    } finally {
      autoSetupRuntimeButton.disabled = runtimeReady;
      autoSetupRuntimeButton.textContent = previousLabel;
    }
  };

  const runAutoSetup = async (): Promise<void> => {
    runtimeReady = false;
    setInlineMessage(elements.runtimeMessage, "", "default");
    setInlineMessage(elements.saveMessage, "", "default");
    autoSetupRuntimeButton.disabled = true;
    const previousLabel = autoSetupRuntimeButton.textContent ?? "Auto Setup Voice Runtime";
    autoSetupRuntimeButton.textContent = "Setting up...";
    setStatus("Running automatic voice runtime setup. This can take several minutes...");
    try {
      const result = await appApi.wizard.autoSetupRuntime();

      if (!result.ok) {
        const reason = result.stage ? `[${result.stage}] ${result.error ?? "setup failed"}` : result.error ?? "setup failed";
        setInlineMessage(elements.runtimeMessage, reason, "error");
        setStatus("Voice runtime setup failed.");
        return;
      }

      if (result.whisperBinaryPath) {
        elements.whisperBinaryPath.value = result.whisperBinaryPath;
      }
      if (result.whisperModelPath) {
        elements.whisperModelPath.value = result.whisperModelPath;
      }
      if (result.pythonPath) {
        elements.pythonPath.value = result.pythonPath;
      }
      if (result.qwenModelPath) {
        elements.qwenModelPath.value = result.qwenModelPath;
      }
      runtimeReady = true;
      setInlineMessage(elements.runtimeMessage, "Voice runtime is installed and ready.", "success");
      setStatus("Voice runtime setup complete.");
    } catch (error) {
      runtimeReady = false;
      setInlineMessage(
        elements.runtimeMessage,
        error instanceof Error ? error.message : String(error),
        "error"
      );
      setStatus("Voice runtime setup failed.");
    } finally {
      autoSetupRuntimeButton.disabled = runtimeReady;
      autoSetupRuntimeButton.textContent = previousLabel;
    }
  };

  autoSetupRuntimeButton.addEventListener("click", () => {
    void runAutoSetup();
  });

  void runRuntimePrecheck();

  const verifyOpenCodeAndLoadModels = async (): Promise<boolean> => {
    const result = await appApi.wizard.verifyOpenCode({
      baseUrl: elements.opencodeBaseUrl.value.trim(),
      username: elements.opencodeUser.value.trim(),
      password: elements.opencodePass.value
    });

    if (!result.ok) {
      opencodeReady = false;
      setInlineMessage(elements.opencodeMessage, result.error ?? "Unknown error", "error");
      setInlineMessage(elements.opencodeModelMessage, "", "default");
      setStatus("OpenCode verification failed.");
      return false;
    }

    opencodeReady = true;
    setInlineMessage(elements.opencodeMessage, `Connected. Version: ${result.version ?? "unknown"}`, "success");
    setStatus(`OpenCode connected. Version: ${result.version ?? "unknown"}`);

    const models = result.models ?? [];
    populateOpenCodeModels(models);
    const healthWarning = result.healthError ? `Health warning: ${result.healthError}` : "";

    if (models.length > 0) {
      const selectedValue = elements.opencodeModelSelect.value;
      const selected = selectedValue
        ? selectedValue
        : result.defaultModel
          ? `auto (server default: ${result.defaultModel})`
          : "auto";
      const modelMessage = `Loaded ${models.length} models. Selected: ${selected}${healthWarning ? `. ${healthWarning}` : ""}`;
      setInlineMessage(elements.opencodeModelMessage, modelMessage, result.healthError ? "default" : "success");
    } else if (result.modelListError) {
      const modelError = healthWarning ? `${result.modelListError}. ${healthWarning}` : result.modelListError;
      setInlineMessage(elements.opencodeModelMessage, modelError, "error");
    } else {
      setInlineMessage(
        elements.opencodeModelMessage,
        `No models reported by server. Agent calls will use server default model.${healthWarning ? ` ${healthWarning}` : ""}`,
        "default"
      );
    }

    return true;
  };

  elements.browseVault.addEventListener("click", async () => {
    const result = await appApi.wizard.chooseDirectory();
    if (!result.canceled) {
      elements.vaultPath.value = result.path;
      setStatus(`Vault selected: ${result.path}`);
    }
  });

  elements.testObsidian.addEventListener("click", async () => {
    setStatus("Testing Obsidian CLI...");
    setInlineMessage(elements.obsidianTestMessage, "Testing...", "default");
    elements.testObsidian.disabled = true;
    const previousLabel = elements.testObsidian.textContent ?? "Test";
    elements.testObsidian.textContent = "Testing...";
    try {
      const result = await appApi.wizard.probeObsidianCli(elements.obsidianCliPath.value.trim());
      if (result.ok) {
        setInlineMessage(elements.obsidianTestMessage, "Obsidian CLI test passed.", "success");
        setStatus("Obsidian CLI is reachable.");
      } else {
        const reason = result.stderr || result.stdout || "Unknown error";
        setInlineMessage(elements.obsidianTestMessage, reason, "error");
        setStatus(`Obsidian CLI failed: ${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setInlineMessage(elements.obsidianTestMessage, reason, "error");
      setStatus(`Obsidian CLI failed: ${reason}`);
    } finally {
      elements.testObsidian.disabled = false;
      elements.testObsidian.textContent = previousLabel;
    }
  });

  elements.testWhisper.addEventListener("click", async () => {
    setStatus("Testing whisper.cpp binary...");
    setInlineMessage(elements.whisperTestMessage, "Testing...", "default");
    elements.testWhisper.disabled = true;
    const previousLabel = elements.testWhisper.textContent ?? "Test";
    elements.testWhisper.textContent = "Testing...";
    try {
      const result = await appApi.wizard.probeWhisperCli(elements.whisperBinaryPath.value.trim());
      if (result.ok) {
        setInlineMessage(elements.whisperTestMessage, "whisper.cpp test passed.", "success");
        setStatus("whisper.cpp binary is reachable.");
      } else {
        const reason = result.stderr || result.stdout || "Unknown error";
        setInlineMessage(elements.whisperTestMessage, reason, "error");
        setStatus(`whisper.cpp probe failed: ${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setInlineMessage(elements.whisperTestMessage, reason, "error");
      setStatus(`whisper.cpp probe failed: ${reason}`);
    } finally {
      elements.testWhisper.disabled = false;
      elements.testWhisper.textContent = previousLabel;
    }
  });

  elements.downloadWhisper.addEventListener("click", async () => {
    setStatus("Downloading whisper model...");
    try {
      const result = await appApi.wizard.downloadWhisperModel();
      elements.whisperModelPath.value = result.modelPath;
      setStatus(`whisper model downloaded: ${result.modelPath}`);
    } catch (error) {
      setInlineMessage(elements.runtimeMessage, error instanceof Error ? error.message : String(error), "error");
      setStatus("whisper model download failed.");
    }
  });

  elements.downloadQwen.addEventListener("click", async () => {
    setStatus("Downloading Qwen model (this can be very large)...");
    try {
      const result = await appApi.wizard.downloadQwenModel({
        pythonPath: elements.pythonPath.value.trim() || "python"
      });
      elements.qwenModelPath.value = result.modelPath;
      setStatus(`Qwen model downloaded: ${result.modelPath}`);
    } catch (error) {
      setInlineMessage(elements.runtimeMessage, error instanceof Error ? error.message : String(error), "error");
      setStatus("Qwen model download failed.");
    }
  });

  elements.verifyOpenCode.addEventListener("click", async () => {
    setStatus("Verifying OpenCode...");
    opencodeReady = false;
    setInlineMessage(elements.opencodeMessage, "", "default");
    setInlineMessage(elements.opencodeModelMessage, "", "default");
    setInlineMessage(elements.saveMessage, "", "default");
    elements.verifyOpenCode.disabled = true;
    const previousLabel = elements.verifyOpenCode.textContent ?? "Verify OpenCode";
    elements.verifyOpenCode.textContent = "Verifying...";
    try {
      await verifyOpenCodeAndLoadModels();
    } catch (error) {
      opencodeReady = false;
      setInlineMessage(elements.opencodeMessage, error instanceof Error ? error.message : String(error), "error");
      setStatus("OpenCode verification failed.");
    } finally {
      elements.verifyOpenCode.disabled = false;
      elements.verifyOpenCode.textContent = previousLabel;
    }
  });

  elements.saveConfig.addEventListener("click", async () => {
    setInlineMessage(elements.saveMessage, "", "default");

    if (!runtimeReady) {
      setInlineMessage(elements.saveMessage, "Complete voice runtime setup first.", "error");
      setStatus("Cannot save yet.");
      return;
    }

    if (!opencodeReady) {
      setStatus("Verifying OpenCode before save...");
      const verified = await verifyOpenCodeAndLoadModels();
      if (!verified) {
        setInlineMessage(elements.saveMessage, "OpenCode verification failed.", "error");
        setStatus("Cannot save yet.");
        return;
      }
    }

    const cfg = buildConfig(defaultsPayload.runtimeScriptPath);
    setStatus("Saving config and starting runtime...");
    elements.saveConfig.disabled = true;
    const previousLabel = elements.saveConfig.textContent ?? "Save and Start";
    elements.saveConfig.textContent = "Saving...";
    try {
      const result = await appApi.wizard.saveConfig(cfg);
      if (result.ok) {
        setInlineMessage(elements.saveMessage, "Configuration saved.", "success");
        setStatus("Saved. Starting app runtime...");
        return;
      }
      setInlineMessage(elements.saveMessage, result.errors.join(" "), "error");
      setStatus("Save failed.");
    } catch (error) {
      setInlineMessage(elements.saveMessage, error instanceof Error ? error.message : String(error), "error");
      setStatus("Save failed.");
    } finally {
      elements.saveConfig.disabled = false;
      elements.saveConfig.textContent = previousLabel;
    }
  });
}

void init();
