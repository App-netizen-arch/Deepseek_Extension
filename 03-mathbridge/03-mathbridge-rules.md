# 03 — MathBridge Rules

## 1. Invariants

- MathBridge is a local document understanding system.
- No user document is uploaded unless explicitly requested.
- The system never fabricates LaTeX, TikZ, or mathematical claims.
- OCR output is always marked with its confidence.
- AI-generated LaTeX/TikZ must be compiled or validated before display.
- The system never replaces formal proof with simulation or OCR.

## 2. Processing Rules

- Start with born-digital PDFs.
- Use Docling for layout.
- Use Marker for text and structure.
- Use Pix2Text or pix2tex for equations.
- Always preserve the source page and bounding box.
- Always preserve equation numbers when available.

## 3. OCR Quality Rules

- Do not silently smooth incorrect LaTeX.
- Show alternatives when confidence is low.
- Mark low-confidence equations for manual review.
- Target at least 90% usable LaTeX on real-paper benchmarks.
- Usability matters more than exact character-level matching.

## 4. AI Reasoning Rules

- DeepSeek receives MathIR context, not raw 200-page PDFs.
- DeepSeek must cite the theorem, lemma, equation, or figure used.
- If retrieval is incomplete, the system says what is missing.
- Proof-related claims must reference the formal dependencies in MathIR.
- The system never claims a proof is valid without a check.

## 5. Figure Rules

- Start with simple geometric and graph figures only.
- Do not attempt arbitrary scientific figures early.
- Object and relation recognition errors must be visible.
- TikZ output must compile before it is shown as a final diagram.
- Editable TikZ is always shown next to the rendered SVG.

## 6. Validation Rules

- AI-generated LaTeX must compile before display.
- AI-generated TikZ must compile before display.
- Structural validation checks references, labels, and numbering.
- A failed compile enters a repair loop.
- After N failed repairs, return the source and errors instead of a diagram.

## 7. Privacy Rules

- All document processing is local by default.
- No paper content is sent to any OCR API unless the user opts in.
- No paper content is sent to DeepSeek beyond the retrieved MathIR context.
- Extracted documents are stored locally and are deletable.

## 8. Benchmark Rules

- Maintain a benchmark set of real papers.
- Measure text, equation, figure, and reasoning quality separately.
- Never tune only on the benchmark and report misleading scores.
- Report degradation on scanned documents separately.
