# Database and observability

The app keeps a local SQLite database so every voice transaction can be inspected after the fact.

## Storage implementation

Database code lives in `src/main/db.ts` and uses `sql.js`:

- Runs fully in-process (no external DB server).
- Persists to file `data/orbsidian.sqlite` under userData.
- Loads wasm from unpacked path when app is packaged.

This design favors portability and zero external setup.

## Schema overview

`createSchema()` creates four core tables:

| Table | Purpose |
|---|---|
| `app_sessions` | Session lifecycle and context note state |
| `requests` | Per-utterance request status and outcome |
| `command_runs` | Command-level execution telemetry from agent and app fallbacks |
| `activity_events` | Human-readable timeline events shown in Activity panel |

Indexes are added for frequent lookups by session and event time.

## Session and request tracking

Session writes:

- `startSession()` when OpenCode session is created
- `touchSession()` during activity
- `setSessionContext()` for context note updates
- `endSession()` on normal end, error, or expiry

Request writes:

- `createRequest()` on queue consumption start
- `setRequestConfirmation()` when confirmation flow starts
- `finalizeRequest()` with `done`, `cancelled`, or `failed`

## Command telemetry

Both agent-side and app-side operations are stored as command runs:

- `recordAgentCommand()` records command metadata from envelope execution list.
- `recordAppCommand()` records fallback file ops and URI open actions.

Stored fields include stage, command text, cwd, exit code, stdout, stderr, and success flag.

## Activity event timeline

`logEvent()` writes human-readable events with level/type/message and optional JSON payload.

Typical event types include:

- `session_started`
- `request_started`
- `agent_response`
- `awaiting_confirmation`
- `fallback_used`
- `request_done`
- `agent_failure`

The activity renderer requests latest rows via `listEvents(limit)` and displays them in reverse chronological order.

## Persistence model

Every mutating operation calls `persist()`, which serializes DB bytes to disk in sequence using an internal promise chain.

This serialization avoids concurrent file write races while keeping implementation simple.

## Privacy posture

Important privacy characteristic of this codebase:

- Raw microphone audio is not persisted.
- Transcript text and operational metadata are persisted.

This gives high debugging value without keeping full raw voice recordings.

## Manual inspection example

You can inspect the DB with any SQLite-compatible browser/tool that can open SQL.js-generated files.

Example read-only queries:

```sql
SELECT id, status, started_at_ms, ended_at_ms, end_reason
FROM app_sessions
ORDER BY started_at_ms DESC
LIMIT 20;

SELECT id, session_id, seq, status, intent, stop_reason
FROM requests
ORDER BY queued_at_ms DESC
LIMIT 50;
```

<seealso>
    <category ref="related">
        <a href="Architecture-and-runtime-flow.md"/>
        <a href="Renderer-preload-and-ipc.md"/>
        <a href="Troubleshooting-and-debugging.md"/>
    </category>
</seealso>
