# 01 — MathBridge MVP

## 1. Goal

Build the first useful math capability inside Better DeepSeek:

> Select any mathematical equation in Chrome and convert it into editable LaTeX
> with live rendering.

This is the first milestone of the larger MathBridge vision. It intentionally
does not include full PDF ingestion, MathIR, figure understanding, or AI reasoning.

## 2. MVP Scope

### In scope

- Select an equation on a webpage.
- Capture the selection as an image or raw DOM LaTeX when available.
- Extract LaTeX using OCR when only an image is available.
- Show editable LaTeX.
- Render the LaTeX with KaTeX or MathJax.
- Copy LaTeX to clipboard.

### Out of scope for MVP

- Whole-PDF ingestion.
- Scanned document OCR at scale.
- Theorem/definition/proof detection.
- Figure-to-TikZ conversion.
- DeepSeek question answering over papers.
- Cross-reference graphs.

## 3. User Flow

1. User selects an equation on a webpage.
2. A floating action button appears: `Analyze equation`.
3. The extension captures the selection.
4. The captured content is sent to the local MathBridge runtime.
5. If raw LaTeX or MathML is available, it is normalized directly.
6. If only an image is available, an OCR model converts it to LaTeX.
7. The chat shows original, LaTeX, and rendered output.
8. The user edits the LaTeX and sees the render update.

## 4. Tag Format

```

BDS:MATH_ANALYZE
type = "equation"
source = "selection"
engine = "auto"

```

## 5. MVP Pipeline

```text
selection
  → capture image or DOM source
  → detect available representation
  → MathML/LaTeX normalization if present
  → OCR engine if only image
  → editable LaTeX
  → KaTeX/MathJax render
  → interactive card in chat
```

## 6. MVP Components

### Extension

- Selection detection.
- Floating action button.
- Capture image or DOM LaTeX.
- Editable LaTeX editor.
- Live KaTeX/MathJax preview.
- Copy button.

### Local runtime

- Receive capture payload.
- Route to normalization or OCR.
- Return normalized LaTeX.
- Optionally return confidence and alternatives.

### OCR engines

- `pix2tex` as primary.
- `Pix2Text` as fallback.
- `Mathpix` optional if user supplies an API key.

## 7. MVP Data Structures

### Selection Payload

```
{
  "type": "equation",
  "content": "blob_url_or_text",
  "kind": "image",
  "source_url": "https://example.com/paper",
  "page_title": "Paper title"
}
```

### Result

```
{
  "latex": "\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}",
  "confidence": 0.94,
  "alternatives": [],
  "engine": "pix2tex"
}
```

## 8. MVP Acceptance Criteria

- User can select an equation on a real webpage.
- A floating `Analyze equation` button appears.
- The chat shows the original image.
- The chat shows editable LaTeX.
- The chat shows a live rendered equation.
- Copy LaTeX works.
- OCR quality is tested on 100 real equations.
- Target: at least 90% usable LaTeX without manual correction.
- No document is uploaded unless the user explicitly chooses local processing.

