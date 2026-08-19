#!/usr/bin/env python3
"""Local MathBridge PDF adapter.

Priority: Docling v2 Python API, Marker JSON CLI, then PyMuPDF. No remote
services are contacted; the Node runtime validates the local path first.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    raise SystemExit(2)


def safe_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def box_from(value: object) -> dict | None:
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        x0, y0, x1, y1 = [float(value[i]) for i in range(4)]
        return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}
    if isinstance(value, dict):
        try:
            return {"x": float(value.get("x", 0)), "y": float(value.get("y", 0)), "w": float(value.get("w", 0)), "h": float(value.get("h", 0))}
        except Exception:
            return None
    return None


def infer_theorems(texts: list[dict]) -> list[dict]:
    out: list[dict] = []
    for item in texts:
        text = safe_text(item.get("text"))
        match = re.match(r"^(theorem|lemma|proposition|corollary|definition|proof)\s*([\w.-]*)\s*[:.]?\s*(.*)$", text, re.I)
        if match:
            out.append({"id": f"theorem_{len(out)+1:03d}", "kind": match.group(1).lower(), "title": match.group(2) or None, "text": match.group(3) or text, "page": item.get("page"), "dependencies": [], "references": []})
    return out


def infer_equations(texts: list[dict]) -> list[dict]:
    out: list[dict] = []
    for item in texts:
        text = safe_text(item.get("text"))
        if len(text) > 1600:
            continue
        looks_math = bool(re.search(r"(?:\\[A-Za-z]+|\^|_|[A-Za-z]\s*=\s*[A-Za-z0-9])", text)) and bool(re.search(r"=|\\frac|\\int|\\sum|\\prod|\\alpha|\\beta|\\gamma", text))
        if not looks_math:
            continue
        number = re.search(r"\((\d+(?:\.\d+)*)\)\s*$", text)
        out.append({"id": f"eq_{len(out)+1:03d}", "latex": text, "number": number.group(1) if number else None, "page": item.get("page"), "bounding_box": box_from(item.get("bbox")), "confidence": None})
    return out


def walk_docling(node: object, texts: list[dict], figures: list[dict], tables: list[dict], page: int | None = None) -> None:
    if isinstance(node, dict):
        current_page = page
        prov = node.get("prov")
        if isinstance(prov, list) and prov and isinstance(prov[0], dict) and prov[0].get("page_no") is not None:
            current_page = int(prov[0]["page_no"])
        label = str(node.get("label") or node.get("type") or "").lower()
        text = safe_text(node.get("text") or node.get("content") or node.get("caption"))
        bbox = prov[0].get("bbox") if isinstance(prov, list) and prov and isinstance(prov[0], dict) else None
        if text:
            texts.append({"text": text, "page": current_page, "bbox": bbox})
        if "picture" in label or "figure" in label:
            figures.append({"id": f"fig_{len(figures)+1:03d}", "caption": text or None, "page": current_page, "bounding_box": box_from(bbox), "objects": [], "relations": []})
        if "table" in label:
            tables.append({"id": f"table_{len(tables)+1:03d}", "caption": text or None, "page": current_page, "content": text or None})
        for value in node.values():
            walk_docling(value, texts, figures, tables, current_page)
    elif isinstance(node, list):
        for value in node:
            walk_docling(value, texts, figures, tables, page)


def docling_extract(pdf: Path) -> dict | None:
    try:
        from docling.document_converter import DocumentConverter  # type: ignore
    except Exception:
        return None
    try:
        document = DocumentConverter().convert(str(pdf), max_num_pages=100, max_file_size=100 * 1024 * 1024).document
        data = document.export_to_dict()
        texts: list[dict] = []
        figures: list[dict] = []
        tables: list[dict] = []
        walk_docling(data, texts, figures, tables)
        pages = data.get("pages", {}) if isinstance(data, dict) else {}
        return {"ok": True, "title": safe_text(data.get("name") if isinstance(data, dict) else None) or pdf.stem, "pages": len(pages) if isinstance(pages, dict) else 0, "sections": [], "equations": infer_equations(texts), "theorems": infer_theorems(texts), "figures": figures, "tables": tables, "references": [], "relations": [], "metadata": {"adapter": "docling-v2", "docling_available": True}}
    except Exception as exc:
        print(f"docling adapter failed: {exc}", file=sys.stderr)
        return None


def marker_extract(pdf: Path) -> dict | None:
    binary = shutil.which("marker_single")
    if not binary:
        return None
    with tempfile.TemporaryDirectory(prefix="bds-marker-") as temp:
        output_dir = Path(temp)
        try:
            proc = subprocess.run([binary, str(pdf), "--output_format", "json", "--disable_image_extraction", "--output_dir", str(output_dir)], capture_output=True, text=True, timeout=600)
        except Exception:
            return None
        if proc.returncode != 0:
            return None
        candidates = list(output_dir.glob("*.json"))
        if not candidates:
            return None
        try:
            data = json.loads(candidates[0].read_text(encoding="utf-8"))
        except Exception:
            return None
        texts: list[dict] = []
        def walk(node: object, page: int | None = None) -> None:
            if isinstance(node, dict):
                meta = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
                current_page = meta.get("page_id", page)
                text = safe_text(node.get("html") or node.get("text") or node.get("markdown"))
                if text:
                    texts.append({"text": text, "page": current_page, "bbox": meta.get("bbox")})
                for value in node.values():
                    walk(value, current_page)
            elif isinstance(node, list):
                for value in node:
                    walk(value, page)
        walk(data.get("children", []) if isinstance(data, dict) else [])
        return {"ok": True, "title": pdf.stem, "pages": 0, "sections": [], "equations": infer_equations(texts), "theorems": infer_theorems(texts), "figures": [], "tables": [], "references": [], "relations": [], "metadata": {"adapter": "marker-json", "marker_available": True}}


def pymupdf_fallback(pdf: Path) -> dict:
    try:
        import fitz  # type: ignore
    except Exception as exc:
        fail(f"No local PDF adapter is available: {exc}")
    doc = fitz.open(pdf)
    texts: list[dict] = []
    for page_index in range(len(doc)):
        for block in doc[page_index].get_text("blocks"):
            text = safe_text(block[4])
            if text:
                texts.append({"text": text, "page": page_index + 1, "bbox": block[:4]})
    return {"ok": True, "title": safe_text(doc.metadata.get("title")) or pdf.stem, "pages": len(doc), "sections": [], "equations": infer_equations(texts), "theorems": infer_theorems(texts), "figures": [], "tables": [], "references": [], "relations": [], "metadata": {"adapter": "pymupdf-fallback"}}


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: math-pdf-pipeline.py <pdf-path>")
    pdf = Path(sys.argv[1]).expanduser().resolve()
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        fail("input must be an existing local PDF")
    result = docling_extract(pdf) or marker_extract(pdf) or pymupdf_fallback(pdf)
    result.setdefault("metadata", {})["source_path"] = str(pdf)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
