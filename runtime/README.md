# Better DeepSeek Local Runtime — Phase 4

This directory contains the local-first runtime required by the Better DeepSeek agent architecture, including the native Code Agent, Web Agent MVP/production layer, MathBridge MVP, and MathBridge production document pipeline.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0`.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No telemetry or cloud upload is implemented by the runtime by default.
- Web content and document contents are untrusted input and never become tool commands.
- PDFs are accepted only from the configured local `BDS_DOCUMENT_ROOT` (or workspace) and sensitive paths are rejected.
- Math documents remain local and can be deleted from the MathIR store.

## Setup

```bash
cd runtime
npm install
npx playwright install chromium
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
export BDS_SESSION_KEY="$(openssl rand -hex 32)"
export BDS_WORKSPACE="/absolute/path/to/your/project"
export BDS_DOCUMENT_ROOT="/absolute/path/to/papers"
npm run build
npm start
```

For MathBridge PDF ingestion, install the local Python tooling you intend to use. The production adapter prefers Docling v2, then Marker, then PyMuPDF for born-digital fallback. No document is uploaded by the runtime.

## MathBridge production

### PDF → MathIR

```text
BDS:MATH_PDF
  file = "/absolute/path/to/papers/paper.pdf"
  mode = "full"
  output = "mathir"
```

REST:

```text
POST /v1/math/pdf
GET  /v1/math/documents
GET  /v1/math/documents/:id
DELETE /v1/math/documents/:id
```

The resulting MathIR stores document metadata, semantic sections, equations, theorem-like structures, figures, tables, references, relations, page provenance, and bounding boxes when the upstream extractor exposes them.

### MathIR reasoning

```text
BDS:MATH_ASK
  document_id = "doc_001"
  question = "Explain the proof of Theorem 5.2"
```

REST:

```text
POST /v1/math/ask
```

The runtime retrieves only relevant MathIR entities and their dependencies. If `BDS_DEEPSEEK_API_URL` and `BDS_DEEPSEEK_API_KEY` are configured, only the retrieved MathIR context is sent to that endpoint; the original PDF is not sent. Without those variables, the runtime returns a deterministic local-context answer.

### Equation OCR

The existing MVP API remains available:

```text
POST /v1/math/analyze
```

It supports LaTeX, MathML, and local image OCR through pix2tex/Pix2Text, followed by KaTeX validation/rendering.

### TikZ validation and rendering

```text
BDS:TIKZ_RENDER
  source = "\\begin{tikzpicture}..."
  output = "svg"
```

REST:

```text
POST /v1/math/tikz
```

The runtime compiles TikZ locally with `pdflatex` using `-no-shell-escape` and converts the validated PDF to SVG with `dvisvgm`. File/process primitives such as `\\input`, `\\include`, `\\openin`, `\\write18`, and shell escape are rejected before compilation.

## Production Web Agent

The production API follows the specification:

```text
POST   /tasks
GET    /tasks/:id
GET    /tasks/:id/events
POST   /tasks/:id/pause
POST   /tasks/:id/resume
POST   /tasks/:id/cancel
POST   /approvals/:id
GET    /sessions
POST   /sessions
POST   /sessions/:name/save
DELETE /sessions/:name
WS     /ws
```

## Existing MVP endpoints

```text
POST /v1/web/start
GET  /v1/web/status/:task_id
POST /v1/web/cancel
POST /v1/code/execute
POST /v1/math/analyze
WS   /ws
```
