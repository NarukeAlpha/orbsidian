import { app, shell } from "electron";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execCommand, normalizeNotePath } from "./utils";
import { formatWhisperSpawnError, resolveWhisperBinaryPath } from "./whisper-path";

export interface CommandProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function probeObsidianCli(binaryPath: string): Promise<CommandProbeResult> {
  try {
    const result = await execCommand(binaryPath, ["version"], { timeoutMs: 15000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function probeWhisperCli(binaryPath: string): Promise<CommandProbeResult> {
  const resolvedBinaryPath = await resolveWhisperBinaryPath(binaryPath, app.getPath("userData"));

  try {
    const result = await execCommand(resolvedBinaryPath, ["-h"], { timeoutMs: 15000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: formatWhisperSpawnError(resolvedBinaryPath || binaryPath, error)
    };
  }
}

export async function openNoteByUri(vaultPath: string, notePath: string): Promise<string> {
  const vaultName = path.basename(vaultPath);
  const normalized = normalizeNotePath(notePath);
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(normalized)}`;
  await shell.openExternal(uri);
  return uri;
}

function resolveVaultPath(vaultPath: string, notePath: string): string {
  const normalized = normalizeNotePath(notePath);
  const candidate = path.resolve(vaultPath, normalized.endsWith(".md") ? normalized : `${normalized}.md`);
  const vaultRoot = path.resolve(vaultPath);
  if (!candidate.startsWith(vaultRoot)) {
    throw new Error("Resolved note path escaped vault root.");
  }
  return candidate;
}

export async function fallbackCreateNote(vaultPath: string, notePath: string, content: string): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, notePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await access(path.dirname(fullPath));
  await writeFile(fullPath, content ?? "", "utf8");
}

export async function fallbackAppendNote(vaultPath: string, notePath: string, content: string): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, notePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  const existing = await readFile(fullPath, "utf8").catch(() => "");
  const separator = existing.endsWith("\n") || !existing ? "" : "\n";
  await writeFile(fullPath, `${existing}${separator}${content ?? ""}`, "utf8");
}

export async function fallbackUpdateNote(vaultPath: string, notePath: string, content: string): Promise<void> {
  const fullPath = resolveVaultPath(vaultPath, notePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content ?? "", "utf8");
}

export async function fallbackRenameNote(vaultPath: string, fromNotePath: string, toNotePath: string): Promise<void> {
  const fromPath = resolveVaultPath(vaultPath, fromNotePath);
  const toPath = resolveVaultPath(vaultPath, toNotePath);
  await mkdir(path.dirname(toPath), { recursive: true });
  await rename(fromPath, toPath);
}

export async function fallbackMoveNote(vaultPath: string, fromNotePath: string, toNotePath: string): Promise<void> {
  await fallbackRenameNote(vaultPath, fromNotePath, toNotePath);
}
