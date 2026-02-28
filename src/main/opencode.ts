import { AppConfig, AgentEnvelope, PromptResult } from "./types";

export interface OpenCodeModelOption {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["ok", "needs_confirmation", "error"]
    },
    spokenReply: { type: "string" },
    sessionAction: {
      type: "string",
      enum: ["continue", "end"]
    },
    intent: {
      type: "string",
      enum: [
        "create",
        "append",
        "update",
        "summarize",
        "open",
        "rename",
        "move",
        "find_read",
        "set_context",
        "clear_context",
        "none"
      ]
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        notePath: { type: ["string", "null"] },
        obsidianUri: { type: ["string", "null"] }
      },
      required: ["notePath", "obsidianUri"]
    },
    readback: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["none", "note"] },
        notePath: { type: ["string", "null"] },
        text: { type: ["string", "null"] }
      },
      required: ["mode", "notePath", "text"]
    },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        setNotePath: { type: ["string", "null"] },
        clear: { type: "boolean" }
      },
      required: ["setNotePath", "clear"]
    },
    execution: {
      type: "object",
      additionalProperties: false,
      properties: {
        cliAttempted: { type: "boolean" },
        cliSucceeded: { type: "boolean" },
        fallbackUsed: { type: "boolean" },
        commands: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              stage: {
                type: "string",
                enum: ["agent_cli", "app_fallback", "uri_open"]
              },
              command: { type: "string" },
              cwd: { type: ["string", "null"] },
              exitCode: { type: ["number", "null"] },
              stdout: { type: ["string", "null"] },
              stderr: { type: ["string", "null"] },
              success: { type: "boolean" }
            },
            required: ["stage", "command", "cwd", "exitCode", "stdout", "stderr", "success"]
          }
        }
      },
      required: ["cliAttempted", "cliSucceeded", "fallbackUsed", "commands"]
    },
    fallbackAction: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["none", "create", "append", "update", "rename", "move"]
        },
        path: { type: ["string", "null"] },
        targetPath: { type: ["string", "null"] },
        content: { type: ["string", "null"] }
      },
      required: ["type", "path", "targetPath", "content"]
    },
    confirmation: {
      type: "object",
      additionalProperties: false,
      properties: {
        required: { type: "boolean" },
        question: { type: ["string", "null"] },
        replayToken: { type: ["string", "null"] }
      },
      required: ["required", "question", "replayToken"]
    },
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: ["string", "null"] },
        message: { type: ["string", "null"] }
      },
      required: ["code", "message"]
    }
  },
  required: [
    "status",
    "spokenReply",
    "sessionAction",
    "intent",
    "artifacts",
    "readback",
    "context",
    "execution",
    "fallbackAction",
    "confirmation",
    "error"
  ]
};

function defaultEnvelope(): AgentEnvelope {
  return {
    status: "error",
    spokenReply: "I could not parse the agent result.",
    sessionAction: "continue",
    intent: "none",
    artifacts: {
      notePath: null,
      obsidianUri: null
    },
    readback: {
      mode: "none",
      notePath: null,
      text: null
    },
    context: {
      setNotePath: null,
      clear: false
    },
    execution: {
      cliAttempted: false,
      cliSucceeded: false,
      fallbackUsed: false,
      commands: []
    },
    fallbackAction: {
      type: "none"
    },
    confirmation: {
      required: false,
      question: null,
      replayToken: null
    },
    error: {
      code: "invalid_agent_output",
      message: "Agent returned invalid format"
    }
  };
}

export class OpenCodeService {
  private config: AppConfig;
  private client: any;
  private currentAbortController: AbortController | null = null;
  private legacyModelOverride: { providerID: string; modelID: string } | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const sdk = await import("@opencode-ai/sdk");
    const baseUrl = this.config.opencode.baseUrl;

    if (this.config.opencode.username || this.config.opencode.password) {
      const username = this.config.opencode.username || "opencode";
      const auth = Buffer.from(`${username}:${this.config.opencode.password}`).toString("base64");
      this.client = sdk.createOpencodeClient({
        baseUrl,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              Authorization: `Basic ${auth}`
            }
          })
      });
      return;
    }

    this.client = sdk.createOpencodeClient({ baseUrl });
  }

  async listAvailableModels(): Promise<{ ok: boolean; models: OpenCodeModelOption[]; defaultModel?: string; error?: string }> {
    try {
      if (!this.client) {
        await this.connect();
      }

      let providersPayload: any;

      const providersResponse = await this.callSdkMethod<any>((this.client as any).config, "providers", {
        throwOnError: true
      });

      if (providersResponse.ok) {
        providersPayload = providersResponse.data;
      } else {
        const rawProvidersResponse = await this.callRawClient<any>("get", {
          url: "/config/providers"
        });

        if (!rawProvidersResponse.ok) {
          const combinedError = this.joinErrors(
            providersResponse.missing ? undefined : providersResponse.error,
            rawProvidersResponse.error
          );
          return {
            ok: false,
            models: [],
            error: this.decorateConnectionError(combinedError)
          };
        }

        providersPayload = rawProvidersResponse.data;
      }

      const providers = Array.isArray(providersPayload?.providers)
        ? providersPayload.providers
        : Array.isArray(providersPayload?.all)
          ? providersPayload.all
          : [];
      const connectedFromPayload = Array.isArray(providersPayload?.connected)
        ? new Set(providersPayload.connected.map((id: unknown) => String(id)))
        : null;
      const providerState = await this.callRawClient<any>("get", {
        url: "/provider"
      });
      const connectedProviders = providerState.ok && Array.isArray(providerState.data?.connected)
        ? new Set(providerState.data.connected.map((id: unknown) => String(id)))
        : connectedFromPayload;
      const defaults = providersPayload?.default ?? {};

      const options: OpenCodeModelOption[] = [];
      for (const provider of providers) {
        const providerId = String(provider?.id ?? "").trim();
        if (!providerId) {
          continue;
        }

        if (connectedProviders && connectedProviders.size > 0 && !connectedProviders.has(providerId)) {
          continue;
        }

        const providerName = String(provider?.name ?? providerId).trim();
        const modelsMap = provider?.models ?? {};
        for (const [modelIdRaw, modelInfo] of Object.entries(modelsMap)) {
          const modelId = String(modelIdRaw).trim();
          if (!modelId) {
            continue;
          }

          const displayName = String((modelInfo as any)?.name ?? modelId).trim();
          options.push({
            id: `${providerId}/${modelId}`,
            providerId,
            modelId,
            label: `${providerName} / ${displayName}`
          });
        }
      }

      options.sort((a, b) => a.label.localeCompare(b.label));

      let defaultModel: string | undefined;
      if (typeof defaults?.model === "string" && defaults.model.includes("/")) {
        defaultModel = defaults.model;
      }

      if (!defaultModel && typeof providersPayload?.model === "string" && providersPayload.model.includes("/")) {
        defaultModel = providersPayload.model;
      }

      if (!defaultModel) {
        for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
          if (typeof value !== "string") {
            continue;
          }
          if (value.includes("/")) {
            defaultModel = value;
            break;
          }
          if (providers.some((provider: any) => provider?.id === key)) {
            defaultModel = `${key}/${value}`;
            break;
          }
        }
      }

      return {
        ok: true,
        models: options,
        defaultModel
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        models: [],
        error: this.decorateConnectionError(message)
      };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      if (!this.client) {
        await this.connect();
      }

      const globalHealth = await this.callSdkMethod<any>((this.client as any).global, "health", {
        throwOnError: true
      });
      if (globalHealth.ok) {
        return {
          ok: true,
          version: this.extractVersion(globalHealth.data)
        };
      }

      const rawHealth = await this.callRawClient<any>("get", {
        url: "/global/health"
      });
      if (rawHealth.ok) {
        return {
          ok: true,
          version: this.extractVersion(rawHealth.data)
        };
      }

      const appGet = await this.callSdkMethod<any>((this.client as any).app, "get", {
        throwOnError: true
      });
      if (appGet.ok) {
        return {
          ok: true,
          version: this.extractVersion(appGet.data)
        };
      }

      const combinedError = this.joinErrors(
        globalHealth.missing ? undefined : globalHealth.error,
        rawHealth.error,
        appGet.error
      );
      return {
        ok: false,
        error: this.decorateConnectionError(combinedError)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: this.decorateConnectionError(message)
      };
    }
  }

  async createSession(title: string): Promise<string> {
    if (!this.client) {
      await this.connect();
    }

    const response = await this.client.session.create({
      body: {
        title
      }
    });

    return response?.data?.id ?? response?.id;
  }

  async abortSessionRun(opencodeSessionId: string): Promise<void> {
    try {
      if (this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }

      if (!this.client) {
        return;
      }

      await this.client.session.abort({ path: { id: opencodeSessionId } });
    } catch {
      // swallow abort failures
    }
  }

  async promptAgent(input: {
    opencodeSessionId: string;
    transcript: string;
    contextNotePath: string | null;
    replayToken?: string | null;
    followupInstruction?: string;
  }): Promise<PromptResult> {
    if (!this.client) {
      await this.connect();
    }

    this.currentAbortController = new AbortController();

    const promptText = this.buildPrompt(input);

    const timeout = setTimeout(() => {
      this.currentAbortController?.abort();
    }, this.config.opencode.requestTimeoutMs);

    try {
      const body: any = {
        agent: this.config.opencode.agent,
        parts: [
          {
            type: "text",
            text: promptText
          }
        ],
        format: {
          type: "json_schema",
          schema: RESPONSE_SCHEMA
        }
      };

      if (this.config.opencode.providerId && this.config.opencode.modelId) {
        body.model = {
          providerID: this.config.opencode.providerId,
          modelID: this.config.opencode.modelId
        };
      }

      const response = await this.promptSession(input.opencodeSessionId, body, this.currentAbortController.signal);

      const parsed = this.extractEnvelope(response);
      return parsed;
    } finally {
      clearTimeout(timeout);
      this.currentAbortController = null;
    }
  }

  private async promptSession(opencodeSessionId: string, body: any, signal: AbortSignal): Promise<any> {
    const sdkPrompt = await this.callSdkMethod<any>((this.client as any).session, "prompt", {
      path: { id: opencodeSessionId },
      body,
      signal,
      throwOnError: true
    });

    if (sdkPrompt.ok) {
      return sdkPrompt.data;
    }

    const rawPrompt = await this.callRawClient<any>("post", {
      url: "/session/{id}/prompt",
      path: { id: opencodeSessionId },
      body,
      signal
    });

    if (rawPrompt.ok) {
      return rawPrompt.data;
    }

    const legacyChat = await this.promptSessionViaLegacyChat(opencodeSessionId, body, signal);
    if (legacyChat.ok) {
      return legacyChat.data;
    }

    throw new Error(this.joinErrors(sdkPrompt.error, rawPrompt.error, legacyChat.error));
  }

  private async promptSessionViaLegacyChat(
    opencodeSessionId: string,
    body: any,
    signal: AbortSignal
  ): Promise<{ ok: boolean; data?: any; error?: string }> {
    const modelOverride = await this.resolveLegacyChatModel();
    if (!modelOverride) {
      return {
        ok: false,
        error: "Legacy chat fallback needs a resolved provider/model. Verify OpenCode and choose a model first."
      };
    }

    const chatBody = {
      providerID: modelOverride.providerID,
      modelID: modelOverride.modelID,
      agent: body.agent,
      parts: body.parts
    };

    const chatResult = await this.callSdkMethod<any>((this.client as any).session, "chat", {
      path: { id: opencodeSessionId },
      body: chatBody,
      signal,
      throwOnError: true
    });

    if (!chatResult.ok) {
      return {
        ok: false,
        error: chatResult.error
      };
    }

    const messageId = String(chatResult.data?.id ?? "").trim();
    if (!messageId) {
      return {
        ok: true,
        data: chatResult.data
      };
    }

    const messageDetails = await this.callSdkMethod<any>((this.client as any).session, "message", {
      path: {
        id: opencodeSessionId,
        messageID: messageId
      },
      signal,
      throwOnError: true
    });

    if (messageDetails.ok) {
      return {
        ok: true,
        data: messageDetails.data
      };
    }

    return {
      ok: true,
      data: chatResult.data
    };
  }

  private async resolveLegacyChatModel(): Promise<{ providerID: string; modelID: string } | null> {
    if (this.config.opencode.providerId && this.config.opencode.modelId) {
      return {
        providerID: this.config.opencode.providerId,
        modelID: this.config.opencode.modelId
      };
    }

    if (this.legacyModelOverride) {
      return this.legacyModelOverride;
    }

    const available = await this.listAvailableModels();
    if (!available.ok) {
      return null;
    }

    const candidate = available.defaultModel || available.models[0]?.id;
    if (!candidate || !candidate.includes("/")) {
      return null;
    }

    const slashIndex = candidate.indexOf("/");
    const providerID = candidate.slice(0, slashIndex);
    const modelID = candidate.slice(slashIndex + 1);

    if (!providerID || !modelID) {
      return null;
    }

    this.legacyModelOverride = { providerID, modelID };
    return this.legacyModelOverride;
  }

  private async callSdkMethod<T>(
    scope: any,
    method: string,
    options?: any
  ): Promise<{ ok: boolean; data?: T; error?: string; missing?: boolean }> {
    if (!scope || typeof scope[method] !== "function") {
      return {
        ok: false,
        error: `OpenCode SDK method '${method}' is unavailable`,
        missing: true
      };
    }

    try {
      const response = await scope[method](options);
      const unwrapped = this.unwrapSdkResponse<T>(response);
      if (!unwrapped.ok) {
        return {
          ok: false,
          error: unwrapped.error
        };
      }
      return {
        ok: true,
        data: unwrapped.data
      };
    } catch (error) {
      return {
        ok: false,
        error: this.extractError(error)
      };
    }
  }

  private async callRawClient<T>(
    method: "get" | "post",
    options: any
  ): Promise<{ ok: boolean; data?: T; error?: string; missing?: boolean }> {
    const rawClient = this.client?._client;
    if (!rawClient || typeof rawClient[method] !== "function") {
      return {
        ok: false,
        error: "OpenCode SDK raw client is unavailable",
        missing: true
      };
    }

    try {
      const response = await rawClient[method]({
        throwOnError: true,
        ...options,
        ...(method === "post"
          ? {
              headers: {
                "Content-Type": "application/json",
                ...(options?.headers ?? {})
              }
            }
          : {})
      });
      const unwrapped = this.unwrapSdkResponse<T>(response);
      if (!unwrapped.ok) {
        return {
          ok: false,
          error: unwrapped.error
        };
      }
      return {
        ok: true,
        data: unwrapped.data
      };
    } catch (error) {
      return {
        ok: false,
        error: this.extractError(error)
      };
    }
  }

  private unwrapSdkResponse<T>(response: any): { ok: boolean; data?: T; error?: string } {
    if (response && typeof response === "object" && "error" in response && response.error) {
      return {
        ok: false,
        error: this.extractError(response.error)
      };
    }

    if (response && typeof response === "object" && "data" in response) {
      if (typeof response.data === "undefined") {
        return {
          ok: false,
          error: "OpenCode returned an empty response payload"
        };
      }

      return {
        ok: true,
        data: response.data as T
      };
    }

    if (typeof response === "undefined") {
      return {
        ok: false,
        error: "OpenCode returned no response"
      };
    }

    return {
      ok: true,
      data: response as T
    };
  }

  private extractVersion(payload: any): string | undefined {
    const versionCandidates = [
      payload?.version,
      payload?.app?.version,
      payload?.server?.version,
      payload?.meta?.version
    ];

    for (const candidate of versionCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }

    return undefined;
  }

  private extractError(error: unknown): string {
    if (!error) {
      return "Unknown OpenCode error";
    }

    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    if (typeof error === "object") {
      const maybeError = error as Record<string, unknown>;
      const message = maybeError.message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }

      const status = maybeError.status;
      if (typeof status === "number") {
        return `HTTP ${status}`;
      }

      const name = maybeError.name;
      if (typeof name === "string" && name.trim()) {
        return name;
      }

      try {
        return JSON.stringify(maybeError);
      } catch {
        // ignore stringify errors
      }
    }

    return String(error);
  }

  private joinErrors(...errors: Array<string | undefined>): string {
    const unique = Array.from(new Set(errors.filter((item): item is string => Boolean(item && item.trim()))));
    if (unique.length === 0) {
      return "OpenCode request failed";
    }
    return unique.join(" | ");
  }

  private decorateConnectionError(message: string): string {
    if (!message || message.includes("Could not reach OpenCode")) {
      return message;
    }

    if (!this.isConnectionError(message)) {
      return message;
    }

    const hint = this.buildServerStartHint();
    return `${message}. Could not reach OpenCode at ${this.config.opencode.baseUrl}. ${hint}`;
  }

  private isConnectionError(message: string): boolean {
    return /(fetch failed|failed to fetch|econnrefused|enotfound|etimedout|ehostunreach|network|socket hang up|timed out)/i.test(
      message
    );
  }

  private buildServerStartHint(): string {
    try {
      const parsed = new URL(this.config.opencode.baseUrl);
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      if (parsed.hostname) {
        return `Start the server with \`opencode serve --hostname ${parsed.hostname} --port ${port}\` or update the Base URL.`;
      }
    } catch {
      // fall through
    }

    return "Start the OpenCode server or update the Base URL.";
  }

  private buildPrompt(input: {
    transcript: string;
    contextNotePath: string | null;
    replayToken?: string | null;
    followupInstruction?: string;
  }): string {
    const lines: string[] = [
      "You are an Personal Assistant with Obsidian vault access.",
      "Runtime constraints:",
      "- Obsidian app is installed and running with CLI enabled.",
      "- You may execute commands directly.",
      "- Prefer Obsidian CLI first; if CLI operation fails, perform fallback direct vault file operation.",
      "- For rename/move, require explicit voice confirmation before executing.",
      "- Keep replies concise and operational.",
      "",
      "Output requirements:",
      "- Output valid JSON only.",
      "- JSON must strictly match the required schema.",
      "- Include execution.commands entries for each command you executed.",
      "- If open intent is requested, provide artifacts.notePath and artifacts.obsidianUri if available.",
      "- For find+read, include readback.mode='note' and readback.text with full note content.",
      "- Include fallbackAction payload that app can execute if CLI fails.",
      "",
      `User transcript: ${input.transcript}`
    ];

    if (input.contextNotePath) {
      lines.push(`Active context note path: ${input.contextNotePath}`);
    }

    if (input.replayToken) {
      lines.push(`Pending operation replay token: ${input.replayToken}`);
    }

    if (input.followupInstruction) {
      lines.push(`Follow-up instruction: ${input.followupInstruction}`);
    }

    return lines.join("\n");
  }

  private extractEnvelope(response: any): PromptResult {
    const direct = response?.data ?? response;
    if (direct && typeof direct === "object" && direct.status && direct.intent) {
      return {
        envelope: { ...defaultEnvelope(), ...direct },
        rawText: JSON.stringify(direct)
      };
    }

    const messageParts = response?.data?.parts ?? response?.parts ?? response?.data?.message?.parts ?? [];
    const textParts = messageParts
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .filter(Boolean);

    const rawText = textParts.join("\n").trim();

    if (!rawText) {
      return {
        envelope: defaultEnvelope(),
        rawText: ""
      };
    }

    const jsonCandidate = this.extractJson(rawText);

    if (!jsonCandidate) {
      return {
        envelope: defaultEnvelope(),
        rawText
      };
    }

    try {
      const parsed = JSON.parse(jsonCandidate) as AgentEnvelope;
      return {
        envelope: {
          ...defaultEnvelope(),
          ...parsed
        },
        rawText
      };
    } catch {
      return {
        envelope: defaultEnvelope(),
        rawText
      };
    }
  }

  private extractJson(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed;
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return trimmed.slice(start, end + 1);
    }
    return null;
  }
}
