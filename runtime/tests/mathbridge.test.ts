import { describe, expect, it } from "vitest";
import { mathmlToLatex, normalizeLatex, renderLatex } from "../src/mathbridge.js";

describe("MathBridge", () => {
  it("normalizes common TeX delimiters without altering the expression", () => {
    expect(normalizeLatex("$$ x^2 + y^2 = z^2 $$")).toBe("x^2 + y^2 = z^2");
    expect(normalizeLatex("\\[x+y\\]")).toBe("x+y");
  });

  it("extracts embedded TeX from MathML", () => {
    const mathml = '<math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>';
    expect(mathmlToLatex(mathml)).toBe("x^2");
  });

  it("renders valid LaTeX and rejects invalid LaTeX", () => {
    const html = renderLatex("\\int_0^1 x^2 dx");
    expect(html).toContain("katex");
    expect(() => renderLatex("\\notARealCommand")) .toThrow();
  });
});
