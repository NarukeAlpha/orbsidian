import { contextBridge, ipcRenderer } from "electron";
import { CaptureResult } from "../main/types";

const api = {
  orb: {
    onCaptureCommand: (listener: (command: { action: "start" | "stop"; mode: "request" | "confirmation"; silenceMs: number }) => void) => {
      const wrapped = (_event: unknown, payload: { action: "start" | "stop"; mode: "request" | "confirmation"; silenceMs: number }) => {
        listener(payload);
      };
      ipcRenderer.on("capture:command", wrapped);
      return () => ipcRenderer.removeListener("capture:command", wrapped);
    },
    onState: (listener: (payload: { state: string; label: string; queueDepth: number }) => void) => {
      const wrapped = (_event: unknown, payload: { state: string; label: string; queueDepth: number }) => {
        listener(payload);
      };
      ipcRenderer.on("ui:state", wrapped);
      return () => ipcRenderer.removeListener("ui:state", wrapped);
    },
    sendCaptureResult: (payload: CaptureResult) => ipcRenderer.invoke("capture:result", payload),
    cancelTransaction: () => ipcRenderer.invoke("transaction:cancel"),
    openActivityPanel: () => ipcRenderer.invoke("activity:open"),
    requestMicPermission: () => ipcRenderer.invoke("permissions:mic")
  },
  wizard: {
    getDefaults: () => ipcRenderer.invoke("wizard:defaults"),
    chooseDirectory: () => ipcRenderer.invoke("wizard:choose-directory"),
    probeObsidianCli: (binaryPath: string) => ipcRenderer.invoke("wizard:probe-obsidian-cli", binaryPath),
    probeWhisperCli: (binaryPath: string) => ipcRenderer.invoke("wizard:probe-whisper-cli", binaryPath),
    autoSetupRuntime: () => ipcRenderer.invoke("wizard:auto-setup-runtime"),
    downloadWhisperModel: () => ipcRenderer.invoke("wizard:download-whisper"),
    downloadQwenModel: (payload?: { pythonPath?: string }) => ipcRenderer.invoke("wizard:download-qwen", payload),
    verifyOpenCode: (payload: { baseUrl: string; username: string; password: string }) =>
      ipcRenderer.invoke("wizard:verify-opencode", payload),
    saveConfig: (config: unknown) => ipcRenderer.invoke("wizard:save-config", config),
    onDownloadProgress: (
      listener: (payload: {
        stage: string;
        fileName: string;
        fileIndex: number;
        totalFiles: number;
        downloadedBytes: number;
        totalBytes: number;
      }) => void
    ) => {
      const wrapped = (
        _event: unknown,
        payload: {
          stage: string;
          fileName: string;
          fileIndex: number;
          totalFiles: number;
          downloadedBytes: number;
          totalBytes: number;
        }
      ) => {
        listener(payload);
      };
      ipcRenderer.on("wizard:download-progress", wrapped);
      return () => ipcRenderer.removeListener("wizard:download-progress", wrapped);
    },
    onRuntimeProgress: (
      listener: (payload: {
        stage: string;
        message: string;
      }) => void
    ) => {
      const wrapped = (
        _event: unknown,
        payload: {
          stage: string;
          message: string;
        }
      ) => {
        listener(payload);
      };
      ipcRenderer.on("wizard:runtime-progress", wrapped);
      return () => ipcRenderer.removeListener("wizard:runtime-progress", wrapped);
    }
  },
  activity: {
    listEvents: (limit: number) => ipcRenderer.invoke("activity:list", limit),
    onUpdated: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on("activity:updated", wrapped);
      return () => ipcRenderer.removeListener("activity:updated", wrapped);
    }
  }
};

contextBridge.exposeInMainWorld("orbidian", api);
