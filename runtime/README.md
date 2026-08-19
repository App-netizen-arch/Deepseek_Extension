# Better DeepSeek Local Runtime — Phase 3

This directory contains the local-only runtime for Better DeepSeek, including native Code Agent execution, read-only Web Agent research, and the MathBridge equation-analysis MVP.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate with a token in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0` and does not expose a public API.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No cloud upload is implemented by the runtime.
- Code execution uses server-side language allowlists and argument arrays only.
- Web research is read-only and must not log in, submit forms, post, bypass paywalls, or solve CAPTCHAs.
- MathBridge processes equation content locally; remote OCR APIs are not used.
- OCR results always carry a confidence value when the local engine supplies one; otherwise the result explicitly reports confidence as unavailable.

## Setup

```bash
cd runtime
npm install
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
export BDS_WORKSPACE="/absolute/path/to/your/project"
npm run build
npm start
```

`setup-token` prints a token instead of writing it to disk. Keep it local and store it only in the existing Better DeepSeek extension's `chrome.storage.local` through the runtime bridge.

### MathBridge OCR engines

The MVP is local-first. Install one or both Python OCR engines on the same machine when image equations need OCR:

```bash
python3 -m pip install pix2tex
python3 -m pip install pix2text
```

`pix2tex` is the primary image-to-LaTeX engine. `Pix2Text` is the fallback and can return structured recognition scores. urlpix2tex CLI sourcehttps://github.com/lukas-blecher/LaTeX-OCR/blob/main/pix2tex/cli.py urlPix2Text usage sourcehttps://github.com/breezedeus/Pix2Text/blob/main/docs/usage.md

### Environment

```text
BDS_RUNTIME_PORT=3037
BDS_RUNTIME_TOKEN=<32+ character token>
BDS_RUNTIME_DB=./data/runtime.db
BDS_WORKSPACE=/absolute/path/to/project
```

For Lean 4, `BDS_WORKSPACE` should point at the local Lake project. Zig and Python one-shot programs run in isolated temporary directories.

## Phase 3 endpoints

```text
GET  /health
GET  /v1/health
GET  /v1/status                       authenticated
GET  /v1/code/languages               authenticated
POST /v1/code/languages/enable        authenticated
POST /v1/code/execute                 authenticated
POST /v1/web/start                    authenticated
GET  /v1/web/status/:task_id          authenticated
POST /v1/web/cancel                   authenticated
POST /v1/math/analyze                 authenticated
GET  /v1/math/result/:id              authenticated
POST /v1/tags/parse                   authenticated
POST /v1/audit                        authenticated
WS   /ws                              authenticated after first message
```

## MathBridge input

Direct LaTeX:

```json
{"kind":"latex","content":"\\int_0^\\infty e^{-x^2}dx"}
```

MathML containing an `application/x-tex` annotation:

```json
{"kind":"mathml","content":"<math>...</math>"}
```

Image equations use a `data:image/...;base64,...` payload and are processed locally through pix2tex, then Pix2Text if configured as the fallback.

Response shape:

```json
{
  "latex": "\\int_0^\\infty e^{-x^2}dx",
  "confidence": 0.94,
  "alternatives": [],
  "engine": "pix2tex",
  "rendered_html": "<span class=\"katex\">...</span>",
  "source": {
    "kind": "image",
    "source_url": "https://example.com/paper",
    "page_title": "Paper title"
  }
}
```

The runtime validates the resulting LaTeX with KaTeX before returning it. Invalid LaTeX never becomes a successful render result.

## BDS:MATH_ANALYZE

```text
BDS:MATH_ANALYZE
type = "equation"
kind = "latex"
content = "x^2 + y^2 = z^2"
engine = "auto"
```

The Chrome integration overlay includes `bds-mathbridge.js`, which detects selected MathML/KaTeX/MathJax/image equations and exposes an `Analyze equation` action. The result card provides editable LaTeX, a rendered preview, confidence/engine information, and a Copy LaTeX action. Editor changes are sent back through the local runtime for re-validation and rendering.

## Local-only policy

Do not configure Mathpix or another remote OCR service unless the user explicitly opts into that integration. The Phase 3 runtime has no implicit cloud OCR path.
