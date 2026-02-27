import {
  fallbackAppendNote,
  fallbackCreateNote,
  fallbackMoveNote,
  fallbackRenameNote,
  fallbackUpdateNote,
  openNoteByUri
} from "./obsidian";
import { AppDatabase } from "./db";
import { OpenCodeService } from "./opencode";
import { WhisperService } from "./stt";
import { TtsService } from "./tts";
import { AppConfig, AppSession, CaptureResult, OrchestratorState, PromptResult } from "./types";
import { randomId } from "./utils";

interface OrchestratorCallbacks {
  onStateChanged: (state: { state: OrchestratorState; label: string; queueDepth: number }) => void;
  onCaptureCommand: (command: { action: "start" | "stop"; mode: "request" | "confirmation"; silenceMs: number }) => void;
  onActivityRefresh: () => void;
}

interface PendingInput {
  transcript: string;
  mode: "request" | "confirmation";
}

interface ActiveRequest {
  id: string;
  transcript: string;
  seq: number;
}

interface PendingConfirmation {
  requestId: string;
  replayToken: string | null;
  question: string;
}

export class VoiceOrchestrator {
  private config: AppConfig;
  private db: AppDatabase;
  private openCode: OpenCodeService;
  private whisper: WhisperService;
  private tts: TtsService;
  private callbacks: OrchestratorCallbacks;
  private state: OrchestratorState = "idle";
  private queue: PendingInput[] = [];
  private processing = false;
  private currentlyListening = false;
  private appSession: AppSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private pendingConfirmation: PendingConfirmation | null = null;
  private idleInterval: NodeJS.Timeout | null = null;

  constructor(params: {
    config: AppConfig;
    db: AppDatabase;
    openCode: OpenCodeService;
    whisper: WhisperService;
    tts: TtsService;
    callbacks: OrchestratorCallbacks;
  }) {
    this.config = params.config;
    this.db = params.db;
    this.openCode = params.openCode;
    this.whisper = params.whisper;
    this.tts = params.tts;
    this.callbacks = params.callbacks;
    this.startIdleWatcher();
  }

  dispose(): void {
    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }
  }

  handleListenHotkey(): void {
    if (this.currentlyListening) {
      this.cancelListening("manual_stop");
      return;
    }

    const mode: "request" | "confirmation" = this.pendingConfirmation ? "confirmation" : "request";
    this.currentlyListening = true;
    this.setState("listening", mode === "confirmation" ? "Listening for confirmation" : "Listening");
    this.callbacks.onCaptureCommand({
      action: "start",
      mode,
      silenceMs: this.config.stt.silenceMs
    });
  }

  handleTtsSkipHotkey(): void {
    this.tts.skipCurrentChunk();
    this.emitStateLabel("Skipping chunk");
  }

  handleTtsInterruptHotkey(): void {
    this.tts.interruptAll();
    this.emitStateLabel("TTS interrupted");
    void this.tts.speakQuestion("Okay, what next?");
  }

  async cancelCurrentTransaction(reason = "manual_cancel"): Promise<void> {
    this.queue = [];
    this.pendingConfirmation = null;

    this.whisper.cancel();
    this.tts.interruptAll();

    if (this.appSession) {
      await this.openCode.abortSessionRun(this.appSession.opencodeSessionId);
      await this.logEvent("warn", "transaction_cancelled", `Transaction cancelled (${reason})`, {
        reason
      });
    }

    if (this.activeRequest) {
      await this.db.finalizeRequest(this.activeRequest.id, {
        status: "cancelled",
        stopReason: reason,
        intent: "none"
      });
      this.activeRequest = null;
    }

    this.processing = false;
    this.currentlyListening = false;
    this.callbacks.onCaptureCommand({
      action: "stop",
      mode: "request",
      silenceMs: this.config.stt.silenceMs
    });
    this.setState("idle", "Cancelled");
  }

  async handleCaptureResult(result: CaptureResult): Promise<void> {
    this.currentlyListening = false;

    if (!result.hasSpeech) {
      if (this.pendingConfirmation) {
        this.setState("awaiting_confirm", "Awaiting confirmation");
      } else {
        this.setState(this.processing ? "agent_running" : "idle", this.processing ? "Working" : "Idle");
      }
      return;
    }

    this.setState("transcribing", "Transcribing");

    try {
      const transcription = await this.whisper.transcribeBase64Wav(result.audioBase64);
      const transcript = transcription.text.trim();

      if (!transcript) {
        this.setState(this.processing ? "agent_running" : "idle", this.processing ? "Working" : "Idle");
        return;
      }

      if (this.pendingConfirmation || result.mode === "confirmation") {
        await this.handleConfirmationTranscript(transcript);
        return;
      }

      this.queue.push({
        transcript,
        mode: "request"
      });

      this.emitStateLabel(this.processing ? `Queued (${this.queue.length})` : "Queued");

      if (!this.processing) {
        await this.processQueue();
      }
    } catch (error) {
      this.setState("error", "Transcription failed");
      if (this.appSession) {
        await this.logEvent("error", "stt_error", "whisper.cpp failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      if (!this.processing && !this.currentlyListening && !this.pendingConfirmation) {
        this.setState("idle", "Idle");
      }
    }
  }

  private cancelListening(reason: string): void {
    this.currentlyListening = false;
    this.callbacks.onCaptureCommand({
      action: "stop",
      mode: this.pendingConfirmation ? "confirmation" : "request",
      silenceMs: this.config.stt.silenceMs
    });
    this.setState(this.processing ? "agent_running" : "idle", this.processing ? "Working" : "Idle");
    if (this.activeRequest) {
      void this.db.finalizeRequest(this.activeRequest.id, {
        status: "cancelled",
        stopReason: reason,
        intent: "none"
      });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      await this.ensureSession();
      if (!this.appSession) {
        return;
      }

      while (this.queue.length > 0) {
        const input = this.queue.shift()!;
        await this.touchSession();

        const seq = this.db.getNextRequestSeq(this.appSession.id);
        const requestId = randomId("req");
        this.activeRequest = {
          id: requestId,
          transcript: input.transcript,
          seq
        };

        await this.db.createRequest({
          id: requestId,
          sessionId: this.appSession.id,
          seq,
          status: "agent_running",
          transcriptText: input.transcript
        });

        await this.logEvent("info", "request_started", "Request started", {
          transcript: input.transcript,
          seq
        });

        this.setState("agent_running", "Working on your request");
        void this.tts.speakAck("Working on your request.");

        let promptResult: PromptResult;
        try {
          promptResult = await this.openCode.promptAgent({
            opencodeSessionId: this.appSession.opencodeSessionId,
            transcript: input.transcript,
            contextNotePath: this.appSession.activeContextNotePath
          });
        } catch (error) {
          await this.handleAgentFailure(error);
          continue;
        }

        await this.handlePromptResult(promptResult);

        this.activeRequest = null;

        if (!this.appSession) {
          this.queue = [];
          break;
        }
      }
    } finally {
      this.processing = false;
      if (!this.currentlyListening) {
        this.setState("idle", "Idle");
      }
    }
  }

  private async handlePromptResult(promptResult: PromptResult): Promise<void> {
    if (!this.appSession || !this.activeRequest) {
      return;
    }

    const requestId = this.activeRequest.id;
    const envelope = promptResult.envelope;

    await this.logEvent("info", "agent_response", "Agent responded", {
      status: envelope.status,
      intent: envelope.intent,
      raw: promptResult.rawText
    });

    for (const command of envelope.execution.commands ?? []) {
      await this.db.recordAgentCommand(requestId, command);
    }

    if (envelope.status === "needs_confirmation" || envelope.confirmation.required) {
      const question = envelope.confirmation.question || "Please confirm this action. Say yes or no.";
      this.pendingConfirmation = {
        requestId,
        replayToken: envelope.confirmation.replayToken,
        question
      };
      await this.db.setRequestConfirmation(requestId, true, null);
      await this.logEvent("info", "awaiting_confirmation", question, {
        replayToken: envelope.confirmation.replayToken
      });
      this.setState("awaiting_confirm", "Awaiting confirmation");
      void this.tts.speakQuestion(question);
      return;
    }

    if (envelope.status === "error") {
      await this.db.finalizeRequest(requestId, {
        status: "failed",
        stopReason: "agent_error",
        intent: envelope.intent,
        errorCode: envelope.error.code ?? "agent_error",
        errorMessage: envelope.error.message ?? envelope.spokenReply
      });
      await this.logEvent("error", "agent_error", envelope.error.message ?? "Agent returned an error", envelope);
      if (envelope.spokenReply) {
        void this.tts.speakQuestion(envelope.spokenReply);
      }
      return;
    }

    if (!envelope.execution.cliSucceeded && this.config.fallbackFileOpsEnabled && envelope.fallbackAction.type !== "none") {
      const fallbackResult = await this.applyFallbackAction(envelope);
      if (!fallbackResult.ok) {
        await this.db.finalizeRequest(requestId, {
          status: "failed",
          stopReason: "fallback_failed",
          intent: envelope.intent,
          errorCode: "fallback_failed",
          errorMessage: fallbackResult.error
        });
        await this.logEvent("error", "fallback_failed", fallbackResult.error ?? "Fallback failed", {
          envelope
        });
        void this.tts.speakQuestion("I could not complete that action.");
        return;
      }
      envelope.execution.fallbackUsed = true;
    }

    if (envelope.context.clear) {
      this.appSession.activeContextNotePath = null;
      await this.db.setSessionContext(this.appSession.id, null);
      await this.logEvent("info", "context_cleared", "Session context cleared", {});
    } else if (envelope.context.setNotePath) {
      this.appSession.activeContextNotePath = envelope.context.setNotePath;
      await this.db.setSessionContext(this.appSession.id, envelope.context.setNotePath);
      await this.logEvent("info", "context_set", "Session context updated", {
        notePath: envelope.context.setNotePath
      });
    }

    if (envelope.intent === "open" && envelope.artifacts.notePath) {
      this.setState("executing", "Opening note");
      const uri = await openNoteByUri(this.config.vaultPath, envelope.artifacts.notePath);
      await this.db.recordAppCommand(requestId, {
        stage: "uri_open",
        commandText: uri,
        success: true
      });

      await this.db.finalizeRequest(requestId, {
        status: "done",
        intent: envelope.intent
      });
      await this.logEvent("info", "note_opened", "Opened note in Obsidian", {
        uri,
        notePath: envelope.artifacts.notePath
      });
      if (envelope.spokenReply) {
        void this.tts.speakDone(envelope.spokenReply);
      }
      await this.endSession("ended", "open_note");
      return;
    }

    if (envelope.readback.mode === "note" && envelope.readback.text) {
      this.setState("tts_playing", "Reading note");
      const playback = await this.tts.speakReadback(envelope.readback.text);
      if (playback.interrupted) {
        await this.logEvent("warn", "readback_interrupted", "Readback interrupted by user", {});
      } else if (playback.skippedLastChunk) {
        void this.tts.speakQuestion("That is it for this note. Anything else?");
      }
    }

    await this.db.finalizeRequest(requestId, {
      status: "done",
      intent: envelope.intent
    });
    await this.logEvent("info", "request_done", "Request completed", {
      intent: envelope.intent,
      fallbackUsed: envelope.execution.fallbackUsed
    });

    if (envelope.spokenReply) {
      void this.tts.speakDone(envelope.spokenReply);
    }

    if (envelope.sessionAction === "end") {
      await this.endSession("ended", "agent_requested_end");
    }
  }

  private async applyFallbackAction(envelope: PromptResult["envelope"]): Promise<{ ok: boolean; error?: string }> {
    if (!this.activeRequest) {
      return { ok: false, error: "No active request for fallback." };
    }

    const action = envelope.fallbackAction;

    try {
      switch (action.type) {
        case "create":
          if (!action.path) {
            throw new Error("Missing fallback path for create.");
          }
          await fallbackCreateNote(this.config.vaultPath, action.path, action.content ?? "");
          break;
        case "append":
          if (!action.path) {
            throw new Error("Missing fallback path for append.");
          }
          await fallbackAppendNote(this.config.vaultPath, action.path, action.content ?? "");
          break;
        case "update":
          if (!action.path) {
            throw new Error("Missing fallback path for update.");
          }
          await fallbackUpdateNote(this.config.vaultPath, action.path, action.content ?? "");
          break;
        case "rename":
          if (!action.path || !action.targetPath) {
            throw new Error("Missing fallback source/target for rename.");
          }
          await fallbackRenameNote(this.config.vaultPath, action.path, action.targetPath);
          break;
        case "move":
          if (!action.path || !action.targetPath) {
            throw new Error("Missing fallback source/target for move.");
          }
          await fallbackMoveNote(this.config.vaultPath, action.path, action.targetPath);
          break;
        case "none":
        default:
          return { ok: true };
      }

      await this.db.recordAppCommand(this.activeRequest.id, {
        stage: "app_fallback",
        commandText: `fallback:${action.type}`,
        success: true
      });

      await this.logEvent("warn", "fallback_used", "CLI failed, app fallback applied", {
        action
      });

      return { ok: true };
    } catch (error) {
      await this.db.recordAppCommand(this.activeRequest.id, {
        stage: "app_fallback",
        commandText: `fallback:${action.type}`,
        success: false,
        stderr: error instanceof Error ? error.message : String(error)
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async handleConfirmationTranscript(transcript: string): Promise<void> {
    if (!this.pendingConfirmation || !this.appSession) {
      this.queue.push({ transcript, mode: "request" });
      await this.processQueue();
      return;
    }

    const normalized = transcript.trim().toLowerCase();
    const yes = /\b(yes|yep|confirm|do it|proceed|go ahead)\b/.test(normalized);
    const no = /\b(no|cancel|stop|don't|do not)\b/.test(normalized);

    const pending = this.pendingConfirmation;
    this.pendingConfirmation = null;

    if (!yes && !no) {
      this.pendingConfirmation = pending;
      this.setState("awaiting_confirm", "Please say yes or no");
      void this.tts.speakQuestion("Please say yes or no.");
      return;
    }

    if (no) {
      await this.db.setRequestConfirmation(pending.requestId, true, false);
      await this.db.finalizeRequest(pending.requestId, {
        status: "cancelled",
        stopReason: "confirmation_denied",
        intent: "none"
      });
      await this.logEvent("info", "confirmation_denied", "User denied risky action", {
        transcript
      });
      void this.tts.speakDone("Okay, I cancelled that action.");
      this.setState("idle", "Cancelled");
      return;
    }

    await this.db.setRequestConfirmation(pending.requestId, true, true);
    await this.logEvent("info", "confirmation_accepted", "User confirmed risky action", {
      transcript
    });

    this.activeRequest = {
      id: pending.requestId,
      transcript,
      seq: this.db.getNextRequestSeq(this.appSession.id)
    };

    this.setState("agent_running", "Applying confirmed action");

    let promptResult: PromptResult;
    try {
      promptResult = await this.openCode.promptAgent({
        opencodeSessionId: this.appSession.opencodeSessionId,
        transcript,
        contextNotePath: this.appSession.activeContextNotePath,
        replayToken: pending.replayToken,
        followupInstruction: "The user confirmed YES. Execute the pending operation now."
      });
    } catch (error) {
      await this.handleAgentFailure(error);
      this.activeRequest = null;
      return;
    }

    await this.handlePromptResult(promptResult);
    this.activeRequest = null;
  }

  private async ensureSession(): Promise<void> {
    if (this.appSession) {
      return;
    }

    const now = Date.now();
    const appSessionId = randomId("session");
    const title = `Voice Session ${new Date(now).toISOString()}`;

    try {
      const opencodeSessionId = await this.openCode.createSession(title);
      this.appSession = {
        id: appSessionId,
        opencodeSessionId,
        startedAtMs: now,
        lastActivityAtMs: now,
        activeContextNotePath: null
      };
      await this.db.startSession(appSessionId, opencodeSessionId, now);
      await this.logEvent("info", "session_started", "Session started", {
        opencodeSessionId
      });
    } catch (error) {
      this.setState("error", "Could not start OpenCode session");
      throw error;
    }
  }

  private async endSession(status: "ended" | "expired" | "error", reason: string): Promise<void> {
    if (!this.appSession) {
      return;
    }

    const sessionId = this.appSession.id;
    await this.db.endSession(sessionId, status, reason);
    await this.logEvent(status === "error" ? "error" : "info", "session_ended", `Session ended (${reason})`, {
      status,
      reason
    });

    this.appSession = null;
    this.pendingConfirmation = null;
    this.queue = [];
    this.activeRequest = null;
    this.processing = false;

    this.setState("idle", "Idle");
  }

  private async handleAgentFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (this.activeRequest) {
      await this.db.finalizeRequest(this.activeRequest.id, {
        status: "failed",
        stopReason: "agent_failure",
        intent: "none",
        errorCode: "agent_failure",
        errorMessage: message
      });
    }

    await this.logEvent("error", "agent_failure", message, {});

    const authOrNetworkFailure = /(401|403|404|auth|unauthorized|forbidden|network|fetch|connect)/i.test(message);
    if (authOrNetworkFailure) {
      void this.tts.speakQuestion("OpenCode is unavailable or not authenticated. Ending this session.");
      await this.endSession("error", "opencode_unavailable");
      return;
    }

    void this.tts.speakQuestion("I hit an error while processing your request.");
  }

  private async touchSession(): Promise<void> {
    if (!this.appSession) {
      return;
    }
    this.appSession.lastActivityAtMs = Date.now();
    await this.db.touchSession(this.appSession.id);
  }

  private setState(state: OrchestratorState, label: string): void {
    this.state = state;
    this.callbacks.onStateChanged({
      state,
      label,
      queueDepth: this.queue.length
    });
    this.callbacks.onActivityRefresh();
  }

  private emitStateLabel(label: string): void {
    this.callbacks.onStateChanged({
      state: this.state,
      label,
      queueDepth: this.queue.length
    });
    this.callbacks.onActivityRefresh();
  }

  private async logEvent(
    level: "info" | "warn" | "error",
    type: string,
    message: string,
    payload: unknown
  ): Promise<void> {
    if (!this.appSession) {
      return;
    }

    await this.db.logEvent({
      sessionId: this.appSession.id,
      requestId: this.activeRequest?.id,
      level,
      type,
      message,
      payload
    });
    this.callbacks.onActivityRefresh();
  }

  private startIdleWatcher(): void {
    this.idleInterval = setInterval(() => {
      void this.checkIdleTimeout();
    }, 60_000);
  }

  private async checkIdleTimeout(): Promise<void> {
    if (!this.appSession || this.processing || this.currentlyListening) {
      return;
    }

    const idleMs = Date.now() - this.appSession.lastActivityAtMs;
    if (idleMs >= this.config.idleSessionExpiryMs) {
      await this.endSession("expired", "idle_timeout");
      void this.tts.speakQuestion("Session expired after inactivity. Press the hotkey when you are ready.");
    }
  }
}
