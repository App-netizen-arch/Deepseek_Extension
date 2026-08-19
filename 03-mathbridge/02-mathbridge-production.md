# 02 — MathBridge Production

## 1. Goal

Turn equation OCR into a complete mathematical document understanding system:

```

PDF / webpage / image
↓
document understanding
↓
MathIR
↓
LaTeX / TikZ / JSON
↓
DeepSeek reasoning
↓
human-readable answer
↓
optional visual reconstruction

```

## 2. Production Features

| Feature | Description |
|---|---|
| Full PDF ingestion | Born-digital first, then scanned PDFs |
| Layout analysis | Headings, sections, figures, tables, references |
| Equation detection | Equation location, numbering, LaTeX |
| Theorem environment detection | Definitions, lemmas, propositions, proofs |
| Cross-reference graph | Theorems, lemmas, equations, figures dependencies |
| Figure understanding | Geometry, graphs, commutative diagrams first |
| TikZ generation | Editable TikZ with live compile |
| MathIR export | Structured JSON plus markdown |
| DeepSeek reasoning | Context-aware Q&A over MathIR |
| Validation and repair | Compile-and-check AI-generated LaTeX/TikZ |

## 3. Full Pipeline

```text
PDF / webpage / image
      ↓
Docling → layout
      ↓
Marker → text and structure
      ↓
Pix2Text → equations
      ↓
MathIR normalization
      ↓
LaTeX / TikZ / JSON export
      ↓
DeepSeek reasoning
      ↓
cited answer + optional visual reconstruction
```

## 4. MathIR Schema

```
{
  "id": "doc_001",
  "title": "Paper Title",
  "sections": [],
  "equations": [],
  "figures": [],
  "tables": [],
  "references": []
}
```

### Equation

```
{
  "id": "eq_001",
  "latex": "\\int_0^\\infty e^{-x^2} dx",
  "number": "2.7",
  "page": 11,
  "bounding_box": { "x": 0, "y": 0, "w": 0, "h": 0 }
}
```

### Figure

```
{
  "id": "fig_001",
  "caption": "A commutative diagram",
  "image": "local_path",
  "tikz": "\\begin{tikzpicture}...\\end{tikzpicture}",
  "objects": [],
  "relations": []
}
```

### Relation

```
{
  "type": "depends_on",
  "from": "theorem_4_3",
  "to": "lemma_4_1"
}
```

## 5. Reasoning Over MathIR

Instead of sending a huge PDF to DeepSeek, the runtime retrieves:

- The target theorem.
- Its dependencies.
- Related definitions.
- Referenced equations.
- Referenced figures.

Then DeepSeek answers using that structured context.

## 6. Figure Understanding

### Initial targets

- Geometry diagrams.
- Graphs.
- Coordinate diagrams.
- Commutative diagrams.
- Simple mathematical illustrations.

### Pipeline

```
figure image
  → vision model
  → objects
  → relations
  → MathIR
  → TikZ generator
  → LaTeX compiler
  → SVG
```

## 7. TikZ Renderer

- TikZ source in.
- Local LaTeX compiler runs.
- SVG out.
- Live editor with instant render.
- User edits TikZ, diagram updates.

## 8. Validation and Repair

```
AI output
  → LaTeX/TikZ parser
  → compile
  → structural validator
  → valid? yes: render / no: repair loop
```

### Validate

- Equation numbering.
- Broken citations.
- Undefined labels.
- Missing figures.
- TikZ structural validity.

## 9. Production Tag Formats

```
BDS:MATH_PDF
  file = "/home/user/papers/paper.pdf"
  mode = "full"
  output = "mathir"

BDS:MATH_ASK
  document_id = "doc_001"
  question = "Explain the proof of Theorem 5.2"

BDS:TIKZ_RENDER
  source = "...TikZ..."
  output = "svg"
```

## 10. Production Acceptance Criteria

- Upload a 100-page born-digital PDF and receive MathIR JSON.
- Navigate the paper through semantic sections, not pages.
- Ask a question and get an answer using theorem dependencies.
- Convert a simple geometry figure to editable TikZ.
- Edit TikZ and see the SVG update.
- AI-generated LaTeX is compiled and checked before display.
- Work on scanned PDFs with acceptable degradation.

