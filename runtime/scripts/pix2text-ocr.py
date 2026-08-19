#!/usr/bin/env python3
import json
import sys

from pix2text import Pix2Text


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pix2text-ocr.py IMAGE", file=sys.stderr)
        return 2
    image_path = sys.argv[1]
    recognizer = Pix2Text.from_config()
    result = recognizer.recognize_formula(image_path, return_text=False)
    if isinstance(result, list):
        candidates = result
    else:
        candidates = [result]
    emitted = False
    for item in candidates:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        score = item.get("score")
        if isinstance(text, str) and text.strip():
            payload = {"latex": text.strip()}
            if isinstance(score, (float, int)):
                payload["confidence"] = float(score)
            print(json.dumps(payload, ensure_ascii=False), flush=True)
            emitted = True
    if not emitted:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
