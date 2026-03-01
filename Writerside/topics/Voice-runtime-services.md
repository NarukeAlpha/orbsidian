# Voice runtime services

This page covers the local voice stack: speech-to-text (STT), text-to-speech (TTS), and the Python runtime bridge.

## Components at a glance

| Component | File | Responsibility |
|---|---|---|
| STT service | `src/main/stt.ts` | Run `whisper.cpp` on recorded WAV data and return transcript text |
| Whisper path resolver | `src/main/whisper-path.ts` | Resolve executable path and produce user-friendly spawn errors |
| TTS service | `src/main/tts.ts` | Generate speech chunks via Python runtime and play them back with skip/interrupt support |
| Python runtime bridge | `runtime/qwen_tts.py` | Load Qwen model and write generated waveform to WAV |

## STT pipeline (`WhisperService`)

`WhisperService.transcribeBase64Wav()` flow:

1. Decode base64 audio from renderer.
2. Write temporary WAV to OS temp directory (`orbsidian-stt`).
3. Spawn `whisper-cli` with configured model path and args.
4. Read generated transcript from output `.txt` file.
5. Clean temporary input/output files.

### GPU fallback behavior

STT supports three modes from config:

- `auto`: try GPU first, then retry CPU if GPU run fails.
- `gpu`: fail hard if GPU run fails.
- `cpu`: skip GPU attempt and run CPU only.

This gives reliable behavior on mixed hardware without changing core orchestration logic.

### Whisper binary path resolution

`resolveWhisperBinaryPath()` handles common deployment realities:

- Custom explicit path.
- Windows extension normalization (`.exe`).
- Auto-setup build locations inside userData tools directory.
- Recursive search fallback in whisper build output.

If spawn fails with `ENOENT`, error text explicitly suggests running auto setup or setting a full binary path.

## TTS pipeline (`TtsService`)

`TtsService` exposes four speech entry points:

- `speakAck()`
- `speakDone()`
- `speakQuestion()`
- `speakReadback()`

All routes call the same private chunked playback flow.

### Chunking strategy

Long text (readback mode) is split by sentence boundaries using `splitIntoChunks()` from `utils.ts`.

- Target chunk size defaults to `420` chars.
- Smaller chunks improve interruption responsiveness.
- Final result reports whether playback was interrupted or final chunk was skipped.

### Playback behavior by platform

Audio playback command is chosen per OS:

- macOS: `afplay`
- Windows: PowerShell `Media.SoundPlayer.PlaySync()`
- Linux/other: `ffplay -nodisp -autoexit`

### User controls

- Skip hotkey kills only current playback process and advances to next chunk.
- Interrupt hotkey kills generation and playback, then exits current speech operation.

This distinction is important for user experience: skip is local, interrupt is global.

## Python bridge (`runtime/qwen_tts.py`)

The script is intentionally small and focused:

- Parse command args (`--model-path`, `--text`, `--output`, speaker/language/device)
- Resolve device preference (`cuda`, `mps`, `cpu`, or auto)
- Load `Qwen3TTSModel.from_pretrained()`
- Generate waveform with `generate_custom_voice()`
- Write WAV via `soundfile`

It returns conventional process exit codes for simple Node-side error handling.

## How orchestration uses these services

`VoiceOrchestrator` treats STT/TTS as pure services:

- STT is called after capture result arrives.
- TTS is called at state transitions (ack, questions, completion, readback).
- TTS status callback updates orb labels (`Speaking x/y`, `Idle`).

This separation makes it easier to replace runtime internals without rewriting orchestration logic.

<seealso>
    <category ref="related">
        <a href="Renderer-preload-and-ipc.md"/>
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
        <a href="Troubleshooting-and-debugging.md"/>
    </category>
    <category ref="external">
        <a href="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice">Qwen model page</a>
        <a href="https://github.com/ggml-org/whisper.cpp">whisper.cpp</a>
    </category>
</seealso>
