# Existing Better DeepSeek Extension Integration Overlay

These files are designed to be imported into the existing Better DeepSeek Chrome extension rather than replacing it.

- `bds-runtime-client.js` — authenticated REST/WS client; token lives in `chrome.storage.local`.
- `bds-tag-bridge.js` — detects `BDS:*` markers from assistant text and forwards them to the local runtime.
- `bds-runtime-status-ui.js` — minimal status surface for the existing extension UI.

The repository currently contains the Better DeepSeek host/plugin source under `dsh-better-deepseek-main/`; the upstream MV3 source is not duplicated here. The overlay therefore keeps the integration boundary explicit until the Chrome source is mounted into this repository.
