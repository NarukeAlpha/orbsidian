import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function resolveWhisperBinaryPath(binaryPath: string, userDataPath: string): Promise<string> {
  const normalized = stripSurroundingQuotes(binaryPath.trim());
  if (!normalized) {
    return normalized;
  }

  const extension = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [normalized];

  if (process.platform === "win32" && !path.extname(normalized)) {
    candidates.push(`${normalized}${extension}`);
  }

  const lowerBase = path.basename(normalized).toLowerCase();
  if (lowerBase === "whisper-cli" || lowerBase === "whisper-cli.exe") {
    const repoDir = path.join(userDataPath, "tools", "whisper.cpp");
    candidates.push(path.join(repoDir, "build", "bin", `whisper-cli${extension}`));
    candidates.push(path.join(repoDir, "build", "bin", "Release", `whisper-cli${extension}`));

    const recursiveCandidate = await findWhisperBinary(path.join(repoDir, "build"));
    if (recursiveCandidate) {
      candidates.push(recursiveCandidate);
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.toLowerCase())) {
      continue;
    }
    seen.add(candidate.toLowerCase());
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return normalized;
}

export function formatWhisperSpawnError(binaryPath: string, error: unknown): string {
  const errnoError = error as NodeJS.ErrnoException;
  if (errnoError?.code === "ENOENT") {
    const extensionHint = process.platform === "win32" ? ".exe" : "";
    return `whisper.cpp binary was not found (${binaryPath}). Run Auto Setup Voice Runtime or set whisper-cli${extensionHint} to a full path.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function stripSurroundingQuotes(value: string): string {
  if (!value) {
    return value;
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }

  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() || details.isDirectory();
  } catch {
    return false;
  }
}

async function findWhisperBinary(rootDir: string): Promise<string | null> {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const expectedName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) {
        return fullPath;
      }
    }
  }

  return null;
}
