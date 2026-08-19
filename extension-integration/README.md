# Existing Better DeepSeek Extension Integration Overlay

These files are designed to be imported into the existing Better DeepSeek Chrome extension rather than replacing it.

- `bds-runtime-client.js` — authenticated REST/WS client; token lives in `chrome.storage.local`.
- `bds-tag-bridge.js` — detects `BDS:*` markers from assistant text and forwards them to the local runtime.
- `bds-runtime-status-ui.js` — status plus Code Agent, Web Agent, and MathBridge result cards.
- `bds-mathbridge.js` — selection detection, MathML/LaTeX extraction, image capture, and the `Analyze equation` floating action.

## MathBridge flow

`BDS:MATH_ANALYZE` is an intent tag. The tag bridge captures the current equation selection and sends the actual local payload to the runtime as `math/analyze`.

Born-digital equations are preferred: MathML or embedded LaTeX is normalized directly. Image equations are converted to a local `data:` payload and sent only to `127.0.0.1` for OCR.

The repository currently contains the Better DeepSeek host/plugin source under `dsh-better-deepseek-main/`; the upstream MV3 source is not duplicated here. The overlay therefore keeps the integration boundary explicit until the Chrome source is mounted into this repository.
