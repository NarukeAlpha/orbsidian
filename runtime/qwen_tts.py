#!/usr/bin/env python3
# pyright: reportMissingImports=false

import argparse
import os
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate TTS audio with Qwen3-TTS CustomVoice.")
    parser.add_argument("--model-path", required=True, help="Local model directory or HF model id")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--output", required=True, help="Output WAV file path")
    parser.add_argument("--speaker", default="Chelsie", help="CustomVoice speaker name")
    parser.add_argument("--language", default="English", help="Language value for generate_custom_voice")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "mps", "cpu"],
        help="Inference device selection",
    )
    return parser.parse_args()


def resolve_device(device_arg: str):
    import torch

    if device_arg == "cuda":
        return "cuda:0", torch.bfloat16

    if device_arg == "mps":
        return "mps", torch.float16

    if device_arg == "cpu":
        return "cpu", torch.float32

    if torch.cuda.is_available():
        return "cuda:0", torch.bfloat16

    mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    if mps_available:
        return "mps", torch.float16

    return "cpu", torch.float32


def load_model(model_path: str, device_map: str, dtype):
    from qwen_tts import Qwen3TTSModel  # type: ignore[attr-defined]

    kwargs = {
        "device_map": device_map,
        "dtype": dtype,
    }

    if device_map.startswith("cuda"):
        kwargs["attn_implementation"] = "flash_attention_2"

    try:
        return Qwen3TTSModel.from_pretrained(model_path, **kwargs)
    except Exception:
        kwargs.pop("attn_implementation", None)
        return Qwen3TTSModel.from_pretrained(model_path, **kwargs)


def main() -> int:
    args = parse_args()

    try:
        import soundfile as sf
    except Exception as exc:
        print(f"Missing dependency 'soundfile': {exc}", file=sys.stderr)
        return 2

    try:
        device_map, dtype = resolve_device(args.device)
        model = load_model(args.model_path, device_map=device_map, dtype=dtype)

        wavs, sample_rate = model.generate_custom_voice(
            text=args.text,
            language=args.language,
            speaker=args.speaker,
        )

        if isinstance(wavs, list):
            waveform = wavs[0]
        else:
            waveform = wavs

        os.makedirs(os.path.dirname(args.output), exist_ok=True)
        sf.write(args.output, waveform, sample_rate)
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
