import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { downloadQwenCustomVoiceModel, downloadWhisperBaseModel, DownloadProgress } from "./model-download";
import { execCommand } from "./utils";

export interface RuntimeSetupProgress {
  stage: string;
  message: string;
}

export interface RuntimeSetupResult {
  whisperBinaryPath: string;
  whisperModelPath: string;
  pythonPath: string;
  qwenModelPath: string;
}

class SetupError extends Error {
  stage: string;

  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}

interface PythonCommand {
  command: string;
  prefixArgs: string[];
}

export async function autoSetupVoiceRuntime(params: {
  userDataPath: string;
  modelsRoot: string;
  onProgress?: (progress: RuntimeSetupProgress) => void;
  onDownloadProgress?: (progress: DownloadProgress) => void;
}): Promise<RuntimeSetupResult> {
  await primeWindowsToolPaths();

  const toolsRoot = path.join(params.userDataPath, "tools");
  await mkdir(toolsRoot, { recursive: true });
  await mkdir(params.modelsRoot, { recursive: true });

  await ensureDependency("git", {
    onProgress: params.onProgress,
    packageId: process.platform === "win32" ? "Git.Git" : "git"
  });

  await ensureDependency("cmake", {
    onProgress: params.onProgress,
    packageId: process.platform === "win32" ? "Kitware.CMake" : "cmake"
  });

  const python = await ensurePython(params.onProgress);

  const whisperBinaryPath = await ensureWhisperCli({
    toolsRoot,
    onProgress: params.onProgress
  });

  params.onProgress?.({
    stage: "whisper_model",
    message: "Ensuring whisper model is available"
  });
  const whisperModelPath = await downloadWhisperBaseModel(params.modelsRoot, params.onDownloadProgress);

  const venvPythonPath = await ensureTtsEnvironment({
    toolsRoot,
    python,
    onProgress: params.onProgress
  });

  params.onProgress?.({
    stage: "qwen_model",
    message: "Ensuring Qwen CustomVoice model is available"
  });
  const qwenModelPath = await downloadQwenCustomVoiceModel(params.modelsRoot, params.onDownloadProgress);

  return {
    whisperBinaryPath,
    whisperModelPath,
    pythonPath: venvPythonPath,
    qwenModelPath
  };
}

async function ensureDependency(
  command: string,
  options: {
    onProgress?: (progress: RuntimeSetupProgress) => void;
    packageId: string;
  }
): Promise<void> {
  await primeWindowsToolPaths();

  const found = await commandAvailable(command, ["--version"]);
  if (found) {
    options.onProgress?.({
      stage: "dependency",
      message: `${command} is already installed`
    });
    return;
  }

  options.onProgress?.({
    stage: "dependency",
    message: `Installing missing dependency: ${command}`
  });

  const installed = await tryInstallDependency(options.packageId);
  if (!installed) {
    throw new SetupError(
      "dependency",
      `Could not install ${command} automatically. Please install it and run setup again.`
    );
  }

  await primeWindowsToolPaths();

  const recheck = await commandAvailable(command, ["--version"]);
  if (!recheck) {
    throw new SetupError("dependency", `Dependency ${command} is still not available after installation.`);
  }
}

async function ensurePython(
  onProgress?: (progress: RuntimeSetupProgress) => void
): Promise<PythonCommand> {
  await primeWindowsToolPaths();

  const existing = await detectPythonCommand();
  if (existing) {
    onProgress?.({
      stage: "python",
      message: `Using Python command: ${existing.command}`
    });
    return existing;
  }

  onProgress?.({
    stage: "python",
    message: "Python not found. Attempting to install."
  });

  const packageId = process.platform === "win32" ? "Python.Python.3.12" : "python@3.12";
  const installed = await tryInstallDependency(packageId);
  if (!installed) {
    throw new SetupError("python", "Python could not be installed automatically.");
  }

  await primeWindowsToolPaths();

  const detected = await detectPythonCommand();
  if (!detected) {
    throw new SetupError("python", "Python is still unavailable after installation.");
  }

  return detected;
}

async function ensureWhisperCli(params: {
  toolsRoot: string;
  onProgress?: (progress: RuntimeSetupProgress) => void;
}): Promise<string> {
  const repoDir = path.join(params.toolsRoot, "whisper.cpp");
  const buildDir = path.join(repoDir, "build");

  const repoExists = await pathExists(repoDir);
  if (!repoExists) {
    params.onProgress?.({
      stage: "whisper_clone",
      message: "Cloning whisper.cpp repository"
    });

    await runCommandStrict({
      stage: "whisper_clone",
      command: "git",
      args: ["clone", "--depth", "1", "https://github.com/ggml-org/whisper.cpp.git", repoDir]
    });
  } else {
    params.onProgress?.({
      stage: "whisper_update",
      message: "Updating whisper.cpp repository"
    });

    await runCommandStrict({
      stage: "whisper_update",
      command: "git",
      args: ["-C", repoDir, "pull", "--ff-only"],
      allowFailure: true
    });
  }

  const binaryCandidates = getWhisperBinaryCandidates(repoDir);
  for (const candidate of binaryCandidates) {
    if (await pathExists(candidate)) {
      params.onProgress?.({
        stage: "whisper_build",
        message: "Found existing whisper-cli binary"
      });
      return candidate;
    }
  }

  params.onProgress?.({
    stage: "whisper_build",
    message: "Configuring whisper.cpp build"
  });

  const baseConfigureArgs = ["-S", repoDir, "-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"];

  const preferredConfigureArgs = [...baseConfigureArgs];
  if (process.platform === "win32") {
    preferredConfigureArgs.push("-DGGML_CUDA=ON");
  } else if (process.platform === "darwin") {
    preferredConfigureArgs.push("-DGGML_METAL=ON");
  }

  const doBuild = async (configureArgs: string[]): Promise<void> => {
    await runCommandStrict({
      stage: "whisper_build",
      command: "cmake",
      args: configureArgs,
      cwd: repoDir
    });
    params.onProgress?.({
      stage: "whisper_build",
      message: "Building whisper.cpp (this can take a while)"
    });
    await runCommandStrict({
      stage: "whisper_build",
      command: "cmake",
      args: ["--build", buildDir, "--config", "Release", "-j"],
      cwd: repoDir
    });
  };

  try {
    await doBuild(preferredConfigureArgs);
  } catch {
    params.onProgress?.({
      stage: "whisper_build",
      message: "GPU build failed, retrying CPU-only build"
    });
    await doBuild(baseConfigureArgs);
  }

  for (const candidate of binaryCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const recursiveCandidate = await findWhisperBinary(buildDir);
  if (recursiveCandidate) {
    return recursiveCandidate;
  }

  throw new SetupError(
    "whisper_build",
    `whisper-cli binary not found after build. Checked expected paths: ${binaryCandidates.join(", ")}`
  );
}

function getWhisperBinaryCandidates(repoDir: string): string[] {
  const extension = process.platform === "win32" ? ".exe" : "";
  return [
    path.join(repoDir, "build", "bin", `whisper-cli${extension}`),
    path.join(repoDir, "build", "bin", "Release", `whisper-cli${extension}`)
  ];
}

async function ensureTtsEnvironment(params: {
  toolsRoot: string;
  python: PythonCommand;
  onProgress?: (progress: RuntimeSetupProgress) => void;
}): Promise<string> {
  const venvDir = path.join(params.toolsRoot, "qwen-tts-venv");
  const venvPythonPath = getVenvPythonPath(venvDir);

  if (!(await pathExists(venvPythonPath))) {
    params.onProgress?.({
      stage: "tts_env",
      message: "Creating Python virtual environment for TTS"
    });

    await runCommandStrict({
      stage: "tts_env",
      command: params.python.command,
      args: [...params.python.prefixArgs, "-m", "venv", venvDir]
    });
  }

  params.onProgress?.({
    stage: "tts_env",
    message: "Installing Python dependencies for Qwen TTS"
  });

  await runCommandStrict({
    stage: "tts_env",
    command: venvPythonPath,
    args: ["-m", "pip", "install", "-U", "pip", "setuptools", "wheel"]
  });

  if (process.platform === "win32") {
    try {
      await runCommandStrict({
        stage: "tts_env",
        command: venvPythonPath,
        args: [
          "-m",
          "pip",
          "install",
          "torch",
          "torchvision",
          "torchaudio",
          "--index-url",
          "https://download.pytorch.org/whl/cu128"
        ]
      });
    } catch {
      await runCommandStrict({
        stage: "tts_env",
        command: venvPythonPath,
        args: [
          "-m",
          "pip",
          "install",
          "torch",
          "torchvision",
          "torchaudio",
          "--index-url",
          "https://download.pytorch.org/whl/cpu"
        ]
      });
    }
  } else {
    await runCommandStrict({
      stage: "tts_env",
      command: venvPythonPath,
      args: ["-m", "pip", "install", "torch", "torchvision", "torchaudio"]
    });
  }

  await runCommandStrict({
    stage: "tts_env",
    command: venvPythonPath,
    args: ["-m", "pip", "install", "qwen-tts", "soundfile"]
  });

  return venvPythonPath;
}

function getVenvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

async function detectPythonCommand(): Promise<PythonCommand | null> {
  const probes: PythonCommand[] = [
    { command: "python", prefixArgs: [] },
    { command: "python3", prefixArgs: [] },
    { command: "py", prefixArgs: ["-3"] }
  ];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const windowsCandidates = [
      "C:/Python312/python.exe",
      "C:/Program Files/Python312/python.exe",
      path.join(localAppData, "Programs", "Python", "Python312", "python.exe")
    ];

    for (const candidate of windowsCandidates) {
      if (await pathExists(candidate)) {
        probes.unshift({ command: candidate, prefixArgs: [] });
      }
    }
  }

  for (const probe of probes) {
    const ok = await commandAvailable(probe.command, [...probe.prefixArgs, "--version"]);
    if (ok) {
      return probe;
    }
  }

  return null;
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await execCommand(command, args, { timeoutMs: 15000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function findWhisperBinary(rootDir: string): Promise<string | null> {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const queue = [rootDir];
  const fileName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath;
      }
    }
  }

  return null;
}

async function runCommandStrict(params: {
  stage: string;
  command: string;
  args: string[];
  cwd?: string;
  allowFailure?: boolean;
}): Promise<void> {
  const result = await execCommand(params.command, params.args, {
    cwd: params.cwd,
    timeoutMs: 0
  }).catch((error) => {
    throw new SetupError(params.stage, `${params.command} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (result.code === 0 || params.allowFailure) {
    return;
  }

  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  const details = stderr || stdout || "No additional output.";

  throw new SetupError(
    params.stage,
    `${params.command} ${params.args.join(" ")} failed with exit code ${result.code}. ${truncate(details, 1600)}`
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

async function tryInstallDependency(packageId: string): Promise<boolean> {
  if (process.platform === "win32") {
    const wingetExists = await commandAvailable("winget", ["--version"]);
    if (!wingetExists) {
      return false;
    }

    const result = await execCommand(
      "winget",
      [
        "install",
        "--id",
        packageId,
        "-e",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements"
      ],
      { timeoutMs: 0 }
    ).catch(() => null);

    return Boolean(result && result.code === 0);
  }

  if (process.platform === "darwin") {
    const brewExists = await commandAvailable("brew", ["--version"]);
    if (!brewExists) {
      return false;
    }

    const result = await execCommand("brew", ["install", packageId], { timeoutMs: 0 }).catch(() => null);
    return Boolean(result && result.code === 0);
  }

  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() || details.isDirectory();
  } catch {
    return false;
  }
}

async function primeWindowsToolPaths(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidateDirs = [
    "C:/Program Files/Git/cmd",
    "C:/Program Files/CMake/bin",
    "C:/Python312",
    "C:/Program Files/Python312",
    path.join(localAppData, "Programs", "Python", "Python312"),
    path.join(localAppData, "Programs", "Git", "cmd")
  ];

  for (const candidateDir of candidateDirs) {
    if (!(await pathExists(candidateDir))) {
      continue;
    }
    const currentPath = process.env.PATH ?? "";
    const normalized = candidateDir.replace(/\//g, "\\");
    if (!currentPath.toLowerCase().includes(normalized.toLowerCase())) {
      process.env.PATH = `${currentPath};${normalized}`;
    }
  }
}
