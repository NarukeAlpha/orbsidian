export type OrchestratorState =
  | "idle"
  | "listening"
  | "transcribing"
  | "agent_running"
  | "awaiting_confirm"
  | "executing"
  | "tts_playing"
  | "error";

export interface HotkeyConfig {
  listen: string;
  ttsSkip: string;
  ttsInterrupt: string;
}

export interface SttConfig {
  binaryPath: string;
  modelPath: string;
  gpuMode: "auto" | "cpu" | "gpu";
  language: string;
  silenceMs: number;
  extraArgs: string[];
}

export interface TtsConfig {
  enabled: boolean;
  pythonPath: string;
  modelPath: string;
  runtimeScriptPath: string;
  speaker: string;
  language: string;
  ack: boolean;
  done: boolean;
  readback: boolean;
  chunkChars: number;
}

export interface OpenCodeConfig {
  baseUrl: string;
  username: string;
  password: string;
  agent: string;
  providerId: string;
  modelId: string;
  requestTimeoutMs: number;
}

export interface AppConfig {
  version: number;
  vaultPath: string;
  obsidianCliPath: string;
  hotkeys: HotkeyConfig;
  stt: SttConfig;
  tts: TtsConfig;
  opencode: OpenCodeConfig;
  fallbackFileOpsEnabled: boolean;
  idleSessionExpiryMs: number;
  ui: {
    alwaysOnTop: boolean;
  };
}

export interface AppSession {
  id: string;
  opencodeSessionId: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  activeContextNotePath: string | null;
}

export interface CaptureResult {
  audioBase64: string;
  hasSpeech: boolean;
  durationMs: number;
  mode: "request" | "confirmation";
}

export interface OrbStatePayload {
  state: OrchestratorState;
  label: string;
  queueDepth: number;
}

export interface ActivityEventInput {
  sessionId: string;
  requestId?: string;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  payload?: unknown;
}

export interface AgentCommandRun {
  stage: "agent_cli" | "app_fallback" | "uri_open";
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  success: boolean;
}

export interface AgentFallbackAction {
  type: "none" | "create" | "append" | "update" | "rename" | "move";
  path?: string;
  targetPath?: string;
  content?: string;
}

export interface AgentEnvelope {
  status: "ok" | "needs_confirmation" | "error";
  spokenReply: string;
  sessionAction: "continue" | "end";
  intent:
    | "create"
    | "append"
    | "update"
    | "summarize"
    | "open"
    | "rename"
    | "move"
    | "find_read"
    | "set_context"
    | "clear_context"
    | "none";
  artifacts: {
    notePath: string | null;
    obsidianUri: string | null;
  };
  readback: {
    mode: "none" | "note";
    notePath: string | null;
    text: string | null;
  };
  context: {
    setNotePath: string | null;
    clear: boolean;
  };
  execution: {
    cliAttempted: boolean;
    cliSucceeded: boolean;
    fallbackUsed: boolean;
    commands: AgentCommandRun[];
  };
  fallbackAction: AgentFallbackAction;
  confirmation: {
    required: boolean;
    question: string | null;
    replayToken: string | null;
  };
  error: {
    code: string | null;
    message: string | null;
  };
}

export interface PromptResult {
  envelope: AgentEnvelope;
  rawText: string;
}
