import { describe, expect, it } from "vitest";
import { riskFor } from "../src/code-production.js";

describe("approval continuation contract", () => {
  it("classifies orchestrator-sensitive operations as high risk", () => {
    expect(riskFor("fs.delete")).toBe("high");
    expect(riskFor("git.commit")).toBe("high");
  });
});
