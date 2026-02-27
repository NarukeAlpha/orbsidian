import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { ActivityEventInput, AgentCommandRun } from "./types";

export interface EventRecord {
  id: number;
  sessionId: string;
  requestId: string | null;
  tsMs: number;
  level: string;
  type: string;
  message: string;
  payloadJson: string | null;
}

export class AppDatabase {
  private dbFilePath: string;
  private sql: any;
  private db: any;
  private persistPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dbFilePath = path.join(dataDir, "orbidian.sqlite");
  }

  async init(): Promise<void> {
    const resolvedWasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const wasmPath = resolvedWasmPath.includes("app.asar")
      ? resolvedWasmPath.replace("app.asar", "app.asar.unpacked")
      : resolvedWasmPath;
    this.sql = await initSqlJs({
      locateFile: () => wasmPath
    });

    const exists = await this.fileExists(this.dbFilePath);
    if (exists) {
      const bin = await readFile(this.dbFilePath);
      this.db = new this.sql.Database(bin);
    } else {
      this.db = new this.sql.Database();
    }

    this.createSchema();
    await this.persist();
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const details = await stat(filePath);
      return details.isFile();
    } catch {
      return false;
    }
  }

  private createSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        opencode_session_id TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active','ended','expired','error')),
        end_reason TEXT,
        active_context_note_path TEXT,
        last_activity_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        queued_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        ended_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN (
          'queued','listening','transcribing','agent_running','awaiting_confirm',
          'executing','tts_playing','done','cancelled','failed'
        )),
        stop_reason TEXT,
        transcript_text TEXT,
        intent TEXT,
        requires_confirmation INTEGER NOT NULL DEFAULT 0,
        was_confirmed INTEGER,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(session_id) REFERENCES app_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('agent_cli','app_fallback','uri_open')),
        command_text TEXT,
        cwd TEXT,
        exit_code INTEGER,
        stdout_text TEXT,
        stderr_text TEXT,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        success INTEGER NOT NULL,
        FOREIGN KEY(request_id) REFERENCES requests(id)
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        request_id TEXT,
        ts_ms INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        FOREIGN KEY(session_id) REFERENCES app_sessions(id),
        FOREIGN KEY(request_id) REFERENCES requests(id)
      );

      CREATE INDEX IF NOT EXISTS idx_requests_session_seq ON requests(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_time ON activity_events(session_id, ts_ms);
    `);
  }

  private async persist(): Promise<void> {
    this.persistPromise = this.persistPromise.then(async () => {
      const data = this.db.export();
      await writeFile(this.dbFilePath, Buffer.from(data));
    });
    await this.persistPromise;
  }

  async startSession(sessionId: string, opencodeSessionId: string, startedAtMs: number): Promise<void> {
    this.db.run(
      `INSERT INTO app_sessions (
        id, opencode_session_id, started_at_ms, status, last_activity_at_ms
      ) VALUES (?, ?, ?, 'active', ?)`,
      [sessionId, opencodeSessionId, startedAtMs, startedAtMs]
    );
    await this.persist();
  }

  async endSession(sessionId: string, status: "ended" | "expired" | "error", reason: string): Promise<void> {
    const now = Date.now();
    this.db.run(
      `UPDATE app_sessions
       SET status = ?, end_reason = ?, ended_at_ms = ?, last_activity_at_ms = ?
       WHERE id = ?`,
      [status, reason, now, now, sessionId]
    );
    await this.persist();
  }

  async touchSession(sessionId: string): Promise<void> {
    this.db.run(`UPDATE app_sessions SET last_activity_at_ms = ? WHERE id = ?`, [Date.now(), sessionId]);
    await this.persist();
  }

  async setSessionContext(sessionId: string, notePath: string | null): Promise<void> {
    this.db.run(`UPDATE app_sessions SET active_context_note_path = ?, last_activity_at_ms = ? WHERE id = ?`, [
      notePath,
      Date.now(),
      sessionId
    ]);
    await this.persist();
  }

  getLastSessionActivityMs(sessionId: string): number | null {
    const stmt = this.db.prepare(`SELECT last_activity_at_ms FROM app_sessions WHERE id = ? LIMIT 1`);
    stmt.bind([sessionId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return Number(row.last_activity_at_ms ?? 0);
    }
    stmt.free();
    return null;
  }

  getNextRequestSeq(sessionId: string): number {
    const stmt = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM requests WHERE session_id = ?`);
    stmt.bind([sessionId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return Number(row.next_seq);
    }
    stmt.free();
    return 1;
  }

  async createRequest(request: {
    id: string;
    sessionId: string;
    seq: number;
    status: string;
    transcriptText: string;
  }): Promise<void> {
    const now = Date.now();
    this.db.run(
      `INSERT INTO requests (
        id, session_id, seq, queued_at_ms, started_at_ms, status, transcript_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [request.id, request.sessionId, request.seq, now, now, request.status, request.transcriptText]
    );
    await this.persist();
  }

  async setRequestStatus(requestId: string, status: string): Promise<void> {
    this.db.run(`UPDATE requests SET status = ? WHERE id = ?`, [status, requestId]);
    await this.persist();
  }

  async setRequestConfirmation(requestId: string, required: boolean, wasConfirmed: boolean | null): Promise<void> {
    this.db.run(
      `UPDATE requests SET requires_confirmation = ?, was_confirmed = ?, status = 'awaiting_confirm' WHERE id = ?`,
      [required ? 1 : 0, wasConfirmed === null ? null : wasConfirmed ? 1 : 0, requestId]
    );
    await this.persist();
  }

  async finalizeRequest(requestId: string, result: {
    status: "done" | "cancelled" | "failed";
    stopReason?: string;
    intent?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    this.db.run(
      `UPDATE requests
       SET status = ?, stop_reason = ?, intent = ?, error_code = ?, error_message = ?, ended_at_ms = ?
       WHERE id = ?`,
      [
        result.status,
        result.stopReason ?? null,
        result.intent ?? null,
        result.errorCode ?? null,
        result.errorMessage ?? null,
        Date.now(),
        requestId
      ]
    );
    await this.persist();
  }

  async recordAgentCommand(requestId: string, run: AgentCommandRun): Promise<void> {
    const now = Date.now();
    const id = `${requestId}-${now}-${Math.floor(Math.random() * 10000)}`;
    this.db.run(
      `INSERT INTO command_runs (
        id, request_id, stage, command_text, cwd, exit_code, stdout_text, stderr_text, started_at_ms, ended_at_ms, success
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        requestId,
        run.stage,
        run.command,
        run.cwd ?? null,
        run.exitCode ?? null,
        run.stdout ?? null,
        run.stderr ?? null,
        now,
        now,
        run.success ? 1 : 0
      ]
    );
    await this.persist();
  }

  async recordAppCommand(requestId: string, run: {
    stage: "app_fallback" | "uri_open";
    commandText: string;
    cwd?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    success: boolean;
  }): Promise<void> {
    const now = Date.now();
    const id = `${requestId}-${now}-${Math.floor(Math.random() * 10000)}`;
    this.db.run(
      `INSERT INTO command_runs (
        id, request_id, stage, command_text, cwd, exit_code, stdout_text, stderr_text, started_at_ms, ended_at_ms, success
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        requestId,
        run.stage,
        run.commandText,
        run.cwd ?? null,
        run.exitCode ?? null,
        run.stdout ?? null,
        run.stderr ?? null,
        now,
        now,
        run.success ? 1 : 0
      ]
    );
    await this.persist();
  }

  async logEvent(event: ActivityEventInput): Promise<void> {
    this.db.run(
      `INSERT INTO activity_events (
        session_id, request_id, ts_ms, level, type, message, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.sessionId,
        event.requestId ?? null,
        Date.now(),
        event.level,
        event.type,
        event.message,
        event.payload ? JSON.stringify(event.payload) : null
      ]
    );
    await this.persist();
  }

  listEvents(limit = 300): EventRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, session_id, request_id, ts_ms, level, type, message, payload_json
       FROM activity_events
       ORDER BY id DESC
       LIMIT ?`
    );
    stmt.bind([limit]);

    const rows: EventRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: Number(row.id),
        sessionId: String(row.session_id),
        requestId: row.request_id ? String(row.request_id) : null,
        tsMs: Number(row.ts_ms),
        level: String(row.level),
        type: String(row.type),
        message: String(row.message),
        payloadJson: row.payload_json ? String(row.payload_json) : null
      });
    }
    stmt.free();
    return rows;
  }
}
