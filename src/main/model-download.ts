import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { downloadFile } from "./utils";
import { execCommand } from "./utils";

export interface DownloadProgress {
  stage: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
}

export async function downloadWhisperBaseModel(
  modelsRoot: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const outDir = path.join(modelsRoot, "whisper");
  await mkdir(outDir, { recursive: true });
  const fileName = "ggml-base.en.bin";
  const outPath = path.join(outDir, fileName);
  const url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true";

  if (await fileHasContent(outPath)) {
    onProgress?.({
      stage: "downloading_whisper_model",
      fileName,
      fileIndex: 1,
      totalFiles: 1,
      downloadedBytes: 1,
      totalBytes: 1
    });
    return outPath;
  }

  await downloadFile(url, outPath, (downloadedBytes, totalBytes) => {
    onProgress?.({
      stage: "downloading_whisper_model",
      fileName,
      fileIndex: 1,
      totalFiles: 1,
      downloadedBytes,
      totalBytes
    });
  });

  return outPath;
}

export async function downloadQwenCustomVoiceModel(
  modelsRoot: string,
  onProgress?: (progress: DownloadProgress) => void,
  options: {
    pythonPath?: string;
  } = {}
): Promise<string> {
  const pythonPath = options.pythonPath?.trim() || "python";

  const qwenRoot = path.join(modelsRoot, "qwen");
  const tokenizerRepo = "Qwen/Qwen3-TTS-Tokenizer-12Hz";
  const modelRepo = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice";
  const tokenizerDir = path.join(qwenRoot, "Qwen3-TTS-Tokenizer-12Hz");
  const modelDir = path.join(qwenRoot, "Qwen3-TTS-12Hz-1.7B-CustomVoice");

  await mkdir(qwenRoot, { recursive: true });

  onProgress?.({
    stage: "downloading_qwen_model",
    fileName: "huggingface_hub",
    fileIndex: 0,
    totalFiles: 2,
    downloadedBytes: 0,
    totalBytes: 1
  });

  await ensureHuggingFaceHubAvailable(pythonPath);

  onProgress?.({
    stage: "downloading_qwen_model",
    fileName: "huggingface_hub",
    fileIndex: 0,
    totalFiles: 2,
    downloadedBytes: 1,
    totalBytes: 1
  });

  const downloadTargets = [
    {
      repo: tokenizerRepo,
      localDir: tokenizerDir,
      label: "Qwen3-TTS-Tokenizer-12Hz"
    },
    {
      repo: modelRepo,
      localDir: modelDir,
      label: "Qwen3-TTS-12Hz-1.7B-CustomVoice"
    }
  ];

  for (let index = 0; index < downloadTargets.length; index += 1) {
    const target = downloadTargets[index];

    if (await directoryHasContent(target.localDir)) {
      onProgress?.({
        stage: "downloading_qwen_model",
        fileName: target.label,
        fileIndex: index + 1,
        totalFiles: downloadTargets.length,
        downloadedBytes: 1,
        totalBytes: 1
      });
      continue;
    }

    onProgress?.({
      stage: "downloading_qwen_model",
      fileName: target.label,
      fileIndex: index + 1,
      totalFiles: downloadTargets.length,
      downloadedBytes: 0,
      totalBytes: 1
    });

    await downloadRepoWithHuggingFace(pythonPath, target.repo, target.localDir);

    onProgress?.({
      stage: "downloading_qwen_model",
      fileName: target.label,
      fileIndex: index + 1,
      totalFiles: downloadTargets.length,
      downloadedBytes: 1,
      totalBytes: 1
    });
  }

  return modelDir;
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

async function directoryHasContent(dirPath: string): Promise<boolean> {
  try {
    const details = await stat(dirPath);
    if (!details.isDirectory()) {
      return false;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name.toLowerCase();
      if (name.endsWith(".safetensors") || name === "tokenizer.json" || name === "tokenizer_config.json") {
        if (await fileHasContent(path.join(dirPath, entry.name))) {
          return true;
        }
      }
    }

    const keepFiles = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"];
    for (const keepFile of keepFiles) {
      if (await fileHasContent(path.join(dirPath, keepFile))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function runStrict(command: string, args: string[], errorPrefix: string): Promise<void> {
  const result = await execCommand(command, args, { timeoutMs: 0 }).catch((error) => {
    throw new Error(`${errorPrefix} ${error instanceof Error ? error.message : String(error)}`);
  });

  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || "Unknown error").trim();
    throw new Error(`${errorPrefix} Exit code ${result.code}. ${truncate(details, 1600)}`);
  }
}

async function ensureHuggingFaceHubAvailable(pythonPath: string): Promise<void> {
  const probe = await execCommand(pythonPath, ["-c", "import huggingface_hub"], { timeoutMs: 30_000 }).catch(() => null);
  if (probe && probe.code === 0) {
    return;
  }

  await runStrict(
    pythonPath,
    ["-m", "pip", "install", "huggingface_hub"],
    "Failed to install huggingface_hub package."
  );
}

async function downloadRepoWithHuggingFace(pythonPath: string, repo: string, localDir: string): Promise<void> {
  const cliArgs = ["download", repo, "--local-dir", localDir];
  const cliCandidates = getHuggingFaceCliCandidates(pythonPath);

  let cliFailure: string | null = null;

  for (const cliCommand of cliCandidates) {
    const result = await execCommand(cliCommand, cliArgs, { timeoutMs: 0 }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isCommandNotFoundError(message)) {
        return null;
      }
      throw new Error(`Failed running ${cliCommand}. ${message}`);
    });

    if (!result) {
      continue;
    }

    if (result.code === 0) {
      return;
    }

    const details = (result.stderr || result.stdout || "Unknown error").trim();
    cliFailure = `${cliCommand} exited with code ${result.code}. ${truncate(details, 1600)}`;
    break;
  }

  const fallbackScript =
    "import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])";

  const fallbackResult = await execCommand(
    pythonPath,
    ["-c", fallbackScript, repo, localDir],
    { timeoutMs: 0 }
  ).catch((error) => {
    throw new Error(`Python fallback failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (fallbackResult.code === 0) {
    return;
  }

  const fallbackDetails = (fallbackResult.stderr || fallbackResult.stdout || "Unknown error").trim();
  const message = `Python API fallback failed with exit code ${fallbackResult.code}. ${truncate(fallbackDetails, 1600)}`;
  if (cliFailure) {
    throw new Error(`CLI attempt failed: ${cliFailure} ${message}`);
  }

  throw new Error(message);
}

function getHuggingFaceCliCandidates(pythonPath: string): string[] {
  const candidates: string[] = [];
  const normalized = pythonPath.trim();

  if (normalized && !["python", "python3", "py"].includes(normalized.toLowerCase())) {
    const pythonDir = path.dirname(normalized);
    const pythonDirName = path.basename(pythonDir).toLowerCase();

    let scriptsDir = pythonDir;
    if (process.platform === "win32") {
      if (pythonDirName !== "scripts") {
        scriptsDir = path.join(pythonDir, "Scripts");
      }

      candidates.push(path.join(scriptsDir, "hf.exe"));
      candidates.push(path.join(scriptsDir, "huggingface-cli.exe"));
      candidates.push(path.join(scriptsDir, "hf"));
      candidates.push(path.join(scriptsDir, "huggingface-cli"));
    } else {
      if (pythonDirName !== "bin") {
        scriptsDir = path.join(pythonDir, "bin");
      }
      candidates.push(path.join(scriptsDir, "hf"));
      candidates.push(path.join(scriptsDir, "huggingface-cli"));
    }
  }

  candidates.push("hf", "huggingface-cli");

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function isCommandNotFoundError(message: string): boolean {
  return /enoent|command not found|not recognized as an internal or external command/i.test(message);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}
