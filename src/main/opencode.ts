import { AppConfig, AgentEnvelope, PromptResult } from "./types";

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

  constructor(config: AppConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const sdk = await import("@opencode-ai/sdk");
    const baseUrl = this.config.opencode.baseUrl;

    if (this.config.opencode.username || this.config.opencode.password) {
      const auth = Buffer.from(`${this.config.opencode.username}:${this.config.opencode.password}`).toString("base64");
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

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      if (!this.client) {
        await this.connect();
      }
      const response = await this.client.global.health();
      const version = response?.data?.version ?? response?.version;
      return {
        ok: true,
        version
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
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

      const response = await this.client.session.prompt({
        path: { id: input.opencodeSessionId },
        body,
        signal: this.currentAbortController.signal
      });

      const parsed = this.extractEnvelope(response);
      return parsed;
    } finally {
      clearTimeout(timeout);
      this.currentAbortController = null;
    }
  }

  private buildPrompt(input: {
    transcript: string;
    contextNotePath: string | null;
    replayToken?: string | null;
    followupInstruction?: string;
  }): string {
    const lines: string[] = [
      "You are an Obsidian voice workflow operator.",
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
    const direct = response?.data;
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
