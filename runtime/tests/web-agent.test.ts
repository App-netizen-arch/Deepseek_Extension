import { describe, expect, it } from "vitest";
import { activeWebTaskCount, cancelWebTask } from "../src/web-agent.js";

describe("web agent guards", () => {
  it("starts with no active tasks", () => {
    expect(activeWebTaskCount()).toBe(0);
  });

  it("rejects cancelling an unknown task", () => {
    expect(cancelWebTask("missing-task")).toBe(false);
  });
});
