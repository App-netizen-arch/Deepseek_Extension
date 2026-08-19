import { describe, expect, it } from "vitest";
import { parseBdsTags } from "../src/tag-parser.js";
import { riskFor } from "../src/code-production.js";
import { searchMathIR, type MathIRDocument } from "../src/mathir.js";

describe("production hardening", () => {
  it("keeps destructive Code Agent actions approval-gated", () => {
    expect(riskFor("fs.delete")).toBe("high");
    expect(riskFor("git.commit")).toBe("high");
    expect(riskFor("package.install")).toBe("high");
  });

  it("parses a final BDS tag without re-entering the scan", () => {
    const parsed = parseBdsTags("BDS:AGENT_STATUS\nshow = true\n");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].attributes.show).toBe(true);
  });

  it("searches MathIR across theorem and equation nodes", () => {
    const doc: MathIRDocument = {
      id: "doc-test",
      title: "Test",
      source_path: "/tmp/test.pdf",
      created_at: new Date().toISOString(),
      pages: 1,
      sections: [],
      equations: [{ id: "eq-1", latex: "Kostant problem", page: 1 }],
      theorems: [{ id: "th-1", kind: "theorem", text: "Kostant problem is equivalent", page: 1, dependencies: [], references: [] }],
      figures: [], tables: [], references: [], relations: [], metadata: {},
    };
    expect(searchMathIR(doc, "Kostant problem")).toHaveLength(2);
  });
});
