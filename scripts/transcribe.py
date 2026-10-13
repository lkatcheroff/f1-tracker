"""Transcribe audios de radio con Whisper (faster-whisper, código abierto, en CPU).

Lee por stdin una lista JSON [{"id": ..., "path": ...}] y escribe por stdout un JSON {id: {"text", "lang"}}.
El progreso va a stderr. Uso: .venv-whisper/bin/python scripts/transcribe.py --model small --prompt "..." < lista.json
"""

import argparse
import json
import sys

from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="small")
ap.add_argument("--prompt", default="")
args = ap.parse_args()

items = json.load(sys.stdin)
model = WhisperModel(args.model, device="cpu", compute_type="int8")
out = {}
for i, item in enumerate(items, 1):
    segments, info = model.transcribe(
        item["path"],
        initial_prompt=args.prompt or None,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    # Whisper inventa frases ("Thank you.", subtítulos) sobre ruido o silencio: se descartan los tramos dudosos.
    kept = [s.text.strip() for s in segments if s.no_speech_prob < 0.6 and s.avg_logprob > -1.0]
    out[item["id"]] = {"text": " ".join(t for t in kept if t).strip(), "lang": info.language}
    print(f"[{i}/{len(items)}] {item['id']}: {out[item['id']]['text'][:80]}", file=sys.stderr, flush=True)
json.dump(out, sys.stdout, ensure_ascii=False)
