import { describe, expect, it } from "vitest";
import { riskFor, listTools } from "../src/code-production.js";

describe("production code agent safety", () => {
  it("marks destructive operations as high risk", () => {
    expect(riskFor("fs.delete")).toBe("high");
    expect(riskFor("git.commit")).toBe("high");
  });

  it("exposes only the intended production tools", () => {
    const names = new Set(listTools().map(tool => tool.name));
    expect(names.has("fs.read")).toBe(true);
    expect(names.has("fs.edit")).toBe(true);
    expect(names.has("shell.run")).toBe(true);
    expect(names.has("git.status")).toBe(true);
    expect(names.has("fs.delete")).toBe(true);
  });
});
