import { describe, expect, it } from "vitest";
import { buildReasoningContext, searchMathIR, type MathIRDocument } from "../src/mathir.js";
import { domainAllowed } from "../src/web-production.js";

describe("MathIR", () => {
  const document: MathIRDocument = {
    id: "doc_001",
    title: "Test Paper",
    source_path: "/workspace/paper.pdf",
    created_at: new Date().toISOString(),
    pages: 10,
    sections: [{ id: "sec_1", title: "Main Theorem", level: 1 }],
    equations: [{ id: "eq_1", latex: "a^2+b^2=c^2", page: 2 }],
    theorems: [{ id: "theorem_1", kind: "theorem", title: "Pythagoras", text: "For a right triangle a^2+b^2=c^2", page: 2, dependencies: ["def_1"], references: ["eq_1"] }],
    figures: [], tables: [], references: [], relations: [], metadata: {},
  };

  it("retrieves theorem and equation context", () => {
    const results = searchMathIR(document, "Pythagoras equation");
    expect(results.map((item) => item.id)).toContain("theorem_1");
    const context = buildReasoningContext(document, "Pythagoras");
    expect(context).toContain("[MATHIR]");
    expect(context).toContain("dependencies: def_1");
  });
});

describe("production domain policy regression", () => {
  it("blocks a nested blocked domain even with an allowed-list", () => {
    expect(domainAllowed("private.example.com", ["example.com"], ["private.example.com"])).toBe(false);
  });
});
