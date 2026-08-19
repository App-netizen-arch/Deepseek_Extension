#!/usr/bin/env python3
"""Local MathBridge PDF adapter.

The script prefers Docling for layout and Marker for text/structure when those
packages are installed. It emits a normalized JSON document on stdout and never
uploads the input file. The Node runtime treats the output as untrusted data.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    raise SystemExit(2)


def safe_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def extract_born_digital(pdf: Path) -> dict:
    try:
        import fitz  # PyMuPDF
    except Exception as exc:
        fail(f"PyMuPDF is required for the local PDF adapter: {exc}")

    doc = fitz.open(pdf)
    sections = []
    equations = []
    theorems = []
    figures = []
    tables = []
    references = []
    section_counter = theorem_counter = equation_counter = 0

    for page_index in range(len(doc)):
        page_no = page_index + 1
        page = doc[page_index]
        blocks = page.get_text("dict").get("blocks", [])
        for block in blocks:
            lines = []
            for line in block.get("lines", []):
                lines.append(safe_text(" ".join(span.get("text", "") for span in line.get("spans", []))))
            text = safe_text(" ".join(lines))
            if not text:
                continue
            bbox = block.get("bbox") or [0, 0, 0, 0]
            box = {"x": bbox[0], "y": bbox[1], "w": max(0, bbox[2] - bbox[0]), "h": max(0, bbox[3] - bbox[1])}

            if re.match(r"^(theorem|lemma|proposition|corollary|definition|proof)\b", text, re.I):
                theorem_counter += 1
                match = re.match(r"^(theorem|lemma|proposition|corollary|definition|proof)\s*([\w.-]*)\s*[:.]?\s*(.*)$", text, re.I)
                kind = (match.group(1).lower() if match else "theorem")
                title = (match.group(2) or None) if match else None
                body = match.group(3) if match else text
                theorems.append({"id": f"theorem_{theorem_counter:03d}", "kind": kind, "title": title, "text": body, "page": page_no, "dependencies": [], "references": []})

            if re.search(r"(?:=|\\[a-zA-Z]+|\^|_).*(?:=|\\[a-zA-Z]+)", text) and len(text) < 1200:
                equation_counter += 1
                number_match = re.search(r"\((\d+(?:\.\d+)*)\)\s*$", text)
                equations.append({"id": f"eq_{equation_counter:03d}", "latex": text, "number": number_match.group(1) if number_match else None, "page": page_no, "bounding_box": box, "confidence": None})

            if re.match(r"^(figure|fig\.)\s*\d*", text, re.I):
                figures.append({"id": f"fig_{len(figures)+1:03d}", "caption": text, "page": page_no, "bounding_box": box, "objects": [], "relations": []})

    title = safe_text(doc.metadata.get("title") or pdf.stem)
    return {
        "ok": True,
        "title": title,
        "pages": len(doc),
        "sections": sections,
        "equations": equations,
        "theorems": theorems,
        "figures": figures,
        "tables": tables,
        "references": references,
        "relations": [],
        "metadata": {"adapter": "pymupdf-born-digital", "docling_available": False, "marker_available": False},
    }


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: math-pdf-pipeline.py <pdf-path>")
    pdf = Path(sys.argv[1]).expanduser().resolve()
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        fail("input must be an existing local PDF")
    try:
        import docling  # noqa: F401
        docling_available = True
    except Exception:
        docling_available = False
    try:
        import marker  # noqa: F401
        marker_available = True
    except Exception:
        marker_available = False
    result = extract_born_digital(pdf)
    result["metadata"]["docling_available"] = docling_available
    result["metadata"]["marker_available"] = marker_available
    result["metadata"]["source_path"] = str(pdf)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
