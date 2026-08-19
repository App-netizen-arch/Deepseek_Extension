Better DeepSeek Agent Package 
This package contains the complete specification for extending the Better DeepSeek Chrome extension on chat.deepseek.com
into a local-first, agentic workspace with three core modules: 
Web Agent — autonomous multi-page web research with citations.
Code Agent — local code execution, file editing, builds, and theorem provers.
MathBridge — mathematical document understanding, MathIR, LaTeX/TikZ. 
Each module includes: 
MVP specification
Production-grade specification
Rules and limits 
The architecture is unified: one Chrome extension, one local runtime, modular engines. 
Folder Structure 
 better-deepseek-agent-spec/
├── README.md
├── 00-INTEGRATED-ARCHITECTURE.md
├── 01-web-agent/
│ ├── 01-web-agent-mvp.md
│ ├── 02-web-agent-production.md
│ └── 03-web-agent-rules.md
├── 02-code-agent/
│ ├── 01-code-agent-mvp.md
│ ├── 02-code-agent-production.md
│ └── 03-code-agent-rules.md
├── 03-mathbridge/
│ ├── 01-mathbridge-mvp.md
│ ├── 02-mathbridge-production.md
│ └── 03-mathbridge-rules.md
└── 04-security/
└── 01-global-security-model.md

Recommended Reading Order 
00-INTEGRATED-ARCHITECTURE.md
The MVP file of the module you want to build first.
The corresponding production file.
The corresponding rules file.
04-security/01-global-security-model.md
# Update Summary

New files added:
- `05-project-memory/` — project memory sharing spec.
- `06-kilo-code-components.md` — Kilo Code adoption mapping.

Integration: place in existing `better-deepseek-agent-spec/` folder.

Keep summaries dense; omit long explanations.
</BDS:create_file>

</BDS:LONG_WORK>

Added the project memory sharing spec and Kilo Code component adoption file to the package. Download the ZIP to merge with your existing spec folder.
