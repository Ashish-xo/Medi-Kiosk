#!/usr/bin/env python3
"""Persistent faster-whisper worker for MediKiosk speech-to-text.

Protocol — JSON lines on stdin/stdout:
  in:  {"audio": "/tmp/x.wav", "lang": "hi"}
  out: {"text": "..."}   or   {"error": "..."}

The model is loaded ONCE and reused across requests (spawning per request
would cost ~2s of model load each time). Set WHISPER_MODEL to pick the size:
base (fastest, ~150MB) / small (balanced, ~460MB) / medium / large-v3 (best Hindi).
"""
import json
import os
import sys

MODEL_NAME = os.environ.get('WHISPER_MODEL', 'small')


def main():
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL_NAME, device='cpu', compute_type='int8')

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            audio = req.get('audio')
            lang = req.get('lang') or None
            if not audio or not os.path.exists(audio):
                print(json.dumps({'error': 'audio file missing'}), flush=True)
                continue
            segments, _ = model.transcribe(
                audio,
                language=lang,
                vad_filter=True,
                beam_size=3,
            )
            text = ' '.join(seg.text.strip() for seg in segments).strip()
            print(json.dumps({'text': text}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
