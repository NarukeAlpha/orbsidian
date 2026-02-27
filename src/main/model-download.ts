import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { downloadFile } from "./utils";

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
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const repoId = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice";
  const outDir = path.join(modelsRoot, "qwen", "Qwen3-TTS-12Hz-1.7B-CustomVoice");
  await mkdir(outDir, { recursive: true });

  const apiUrl = `https://huggingface.co/api/models/${encodeURIComponent(repoId)}`;
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch HuggingFace model metadata: HTTP ${response.status}`);
  }

  const json = (await response.json()) as { siblings?: Array<{ rfilename: string }> };
  const files = (json.siblings ?? [])
    .map((entry) => entry.rfilename)
    .filter((name) => name !== ".gitattributes" && name !== "README.md");

  if (files.length === 0) {
    throw new Error("No downloadable files found for Qwen CustomVoice model.");
  }

  for (let index = 0; index < files.length; index += 1) {
    const fileName = files[index];
    const targetPath = path.join(outDir, fileName);

    if (await fileHasContent(targetPath)) {
      onProgress?.({
        stage: "downloading_qwen_model",
        fileName,
        fileIndex: index + 1,
        totalFiles: files.length,
        downloadedBytes: 1,
        totalBytes: 1
      });
      continue;
    }

    const downloadUrl = `https://huggingface.co/${repoId}/resolve/main/${fileName}?download=true`;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await downloadFile(downloadUrl, targetPath, (downloadedBytes, totalBytes) => {
      onProgress?.({
        stage: "downloading_qwen_model",
        fileName,
        fileIndex: index + 1,
        totalFiles: files.length,
        downloadedBytes,
        totalBytes
      });
    });
  }

  return outDir;
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}
