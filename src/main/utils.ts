import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { get } from "node:https";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    onStart?: (pid: number) => void;
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });

    if (options.onStart && child.pid) {
      options.onStart(child.pid);
    }

    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | null = null;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr
      });
    });
  });
}

export async function downloadFile(
  url: string,
  targetPath: string,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  await downloadFileInternal(url, targetPath, onProgress, 5);
}

async function downloadFileInternal(
  url: string,
  targetPath: string,
  onProgress: ((downloadedBytes: number, totalBytes: number) => void) | undefined,
  redirectsRemaining: number
): Promise<void> {
  if (redirectsRemaining < 0) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  await new Promise<void>((resolve, reject) => {
    const request = get(
      url,
      {
        headers: {
          "User-Agent": "orbidian/0.1"
        }
      },
      (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode ?? 0)) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error(`Redirect response missing location while downloading ${url}`));
            return;
          }
          void downloadFileInternal(redirectUrl, targetPath, onProgress, redirectsRemaining - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

      if (!response.statusCode || response.statusCode >= 400) {
        reject(new Error(`Failed to download ${url}. HTTP ${response.statusCode ?? 0}`));
        return;
      }

      const totalBytes = Number(response.headers["content-length"] ?? 0);
      let downloadedBytes = 0;

      const output = createWriteStream(targetPath);
      response.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      response.pipe(output);

      output.on("finish", () => {
        output.close();
        resolve();
      });

      output.on("error", (error) => {
        reject(error);
      });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

export function splitIntoChunks(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized
    .replace(/\n+/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }

    if ((current + " " + sentence).length <= maxChars) {
      current += " " + sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function normalizeNotePath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
