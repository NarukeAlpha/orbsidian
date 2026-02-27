import { existsSync } from "node:fs";
import path from "node:path";
import { expect, Page, test } from "@playwright/test";

const wizardPagePath = path.resolve(process.cwd(), "dist", "renderer", "wizard.html");
const wizardPageUrl = "http://127.0.0.1:4173/wizard.html";

interface MockState {
  autoSetupCalls: number;
  verifyCalls: Array<{ baseUrl: string; username: string; password: string }>;
  saveCalls: any[];
}

async function openWizardWithMockApi(page: Page): Promise<void> {
  if (!existsSync(wizardPagePath)) {
    throw new Error(`Missing ${wizardPagePath}. Run npm run build first.`);
  }

  await page.addInitScript(() => {
    const downloadListeners: Array<(payload: any) => void> = [];
    const runtimeListeners: Array<(payload: any) => void> = [];

    const mockState = {
      autoSetupCalls: 0,
      verifyCalls: [] as Array<{ baseUrl: string; username: string; password: string }>,
      saveCalls: [] as any[]
    };

    const defaults = {
      version: 1,
      vaultPath: "C:/vaults/demo",
      obsidianCliPath: "obsidian",
      hotkeys: {
        listen: "Control+Shift+Space",
        ttsSkip: "Control+Shift+]",
        ttsInterrupt: "Control+Shift+\\"
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
        runtimeScriptPath: "C:/orbsidian/runtime/qwen_tts.py",
        speaker: "Chelsie",
        language: "English",
        ack: true,
        done: true,
        readback: true,
        chunkChars: 420
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096",
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

    (window as any).__wizardMockState = mockState;

    (window as any).orbsidian = {
      wizard: {
        getDefaults: async () => ({
          defaults,
          modelsRoot: "C:/orbsidian/models",
          runtimeScriptPath: "C:/orbsidian/runtime/qwen_tts.py"
        }),
        chooseDirectory: async () => ({ canceled: false, path: "C:/vaults/demo" }),
        probeObsidianCli: async () => ({ ok: true, stdout: "obsidian 1.0.0", stderr: "" }),
        probeWhisperCli: async () => ({ ok: true, stdout: "whisper-cli help", stderr: "" }),
        autoSetupRuntime: async () => {
          mockState.autoSetupCalls += 1;

          runtimeListeners.forEach((listener) =>
            listener({
              stage: "tts_env",
              message: "Installing Python dependencies"
            })
          );

          downloadListeners.forEach((listener) =>
            listener({
              stage: "downloading_qwen_model",
              fileName: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
              fileIndex: 2,
              totalFiles: 2,
              downloadedBytes: 120,
              totalBytes: 200
            })
          );

          return {
            ok: true,
            whisperBinaryPath: "C:/orbsidian/tools/whisper.cpp/build/bin/whisper-cli.exe",
            whisperModelPath: "C:/orbsidian/models/whisper/ggml-base.en.bin",
            pythonPath: "C:/orbsidian/tools/qwen-tts-venv/Scripts/python.exe",
            qwenModelPath: "C:/orbsidian/models/qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
          };
        },
        downloadWhisperModel: async () => ({
          ok: true,
          modelPath: "C:/orbsidian/models/whisper/ggml-base.en.bin"
        }),
        downloadQwenModel: async () => ({
          ok: true,
          modelPath: "C:/orbsidian/models/qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
        }),
        verifyOpenCode: async (payload: { baseUrl: string; username: string; password: string }) => {
          mockState.verifyCalls.push(payload);
          return {
            ok: true,
            version: "0.4.0",
            models: [
              {
                id: "openai/gpt-4.1-mini",
                providerId: "openai",
                modelId: "gpt-4.1-mini",
                label: "OpenAI / gpt-4.1-mini"
              },
              {
                id: "anthropic/claude-sonnet-4",
                providerId: "anthropic",
                modelId: "claude-sonnet-4",
                label: "Anthropic / claude-sonnet-4"
              }
            ],
            defaultModel: "openai/gpt-4.1-mini"
          };
        },
        saveConfig: async (config: any) => {
          mockState.saveCalls.push(config);
          return { ok: true, errors: [] };
        },
        onDownloadProgress: (listener: (payload: any) => void) => {
          downloadListeners.push(listener);
          return () => {
            const index = downloadListeners.indexOf(listener);
            if (index >= 0) {
              downloadListeners.splice(index, 1);
            }
          };
        },
        onRuntimeProgress: (listener: (payload: any) => void) => {
          runtimeListeners.push(listener);
          return () => {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) {
              runtimeListeners.splice(index, 1);
            }
          };
        }
      }
    };
  });

  await page.goto(wizardPageUrl);
}

async function getMockState(page: Page): Promise<MockState> {
  return await page.evaluate(() => (window as any).__wizardMockState);
}

test("auto setup populates runtime fields", async ({ page }) => {
  await openWizardWithMockApi(page);

  await expect(page.locator("#runtimeMessage")).toHaveText("Voice runtime is installed and ready.");
  await expect(page.locator("#whisperBinaryPath")).toHaveValue("C:/orbsidian/tools/whisper.cpp/build/bin/whisper-cli.exe");
  await expect(page.locator("#pythonPath")).toHaveValue("C:/orbsidian/tools/qwen-tts-venv/Scripts/python.exe");

  const mockState = await getMockState(page);
  expect(mockState.autoSetupCalls).toBe(1);
});

test("verify OpenCode loads models and save persists selected model", async ({ page }) => {
  await openWizardWithMockApi(page);

  await expect(page.locator("#runtimeMessage")).toHaveText("Voice runtime is installed and ready.");

  await page.click("#verifyOpenCode");
  await expect(page.locator("#opencodeMessage")).toContainText("Connected. Version: 0.4.0");
  await expect(page.locator("#opencodeModelSelect option")).toHaveCount(3);

  await page.selectOption("#opencodeModelSelect", "anthropic/claude-sonnet-4");
  await page.click("#saveConfig");

  await expect(page.locator("#saveMessage")).toHaveText("Configuration saved.");

  const mockState = await getMockState(page);
  expect(mockState.verifyCalls).toHaveLength(1);
  expect(mockState.saveCalls).toHaveLength(1);
  expect(mockState.saveCalls[0].opencode.providerId).toBe("anthropic");
  expect(mockState.saveCalls[0].opencode.modelId).toBe("claude-sonnet-4");
});
