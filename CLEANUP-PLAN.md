# Repository Cleanup Plan

This repository is being aligned to use `EdgeTypE/better-deepseek` as the extension source of truth.

## Keep
- Upstream Better DeepSeek source/build/test system at repository root
- `runtime/` for the local companion runtime
- numbered specification directories and architecture/security documentation
- release and testing documentation

## Remove
- `chrome-extension/`: superseded hand-written MV3 package; not the upstream extension source
- `dsh-better-deepseek-main/`: duplicated Better DeepSeek source snapshot
- `extension-integration/`: superseded standalone bridge scaffolding; integration will live in the real upstream extension architecture

## Target layout

```text
Deepseek_Extension/
├── upstream Better DeepSeek source
├── runtime/                 # local Node.js companion runtime
├── 00-INTEGRATED-ARCHITECTURE.md
├── 01-web-agent/
├── 02-code-agent/
├── 03-mathbridge/
├── 04-security/
├── 05-project-memory/
├── 06-kilo-code-components.md
├── README.md
├── RELEASE.md
└── TESTING.md
```

No new feature implementation should start until this cleanup is complete. The next work will integrate the requested functions into the upstream Better DeepSeek architecture rather than maintaining a parallel extension implementation.
