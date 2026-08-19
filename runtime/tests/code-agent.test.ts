import { describe, expect, it } from "vitest";
import { CODE_COMMANDS, executeLocalCode } from "../src/code-agent.js";

const auditStore = {
  audit: () => undefined,
} as never;

describe("code agent", () => {
  it("keeps commands as argument arrays", () => {
    for (const command of Object.values(CODE_COMMANDS)) {
      expect(Array.isArray(command)).toBe(true);
      expect(command.join(" ")).not.toContain("&&");
      expect(command.join(" ")).not.toContain(";");
    }
  });

  it("runs an allowlisted Python program and returns structured output", async () => {
    const result = await executeLocalCode({
      language: "python",
      code: 'print("phase1-ok")',
    }, auditStore);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("phase1-ok");
    expect(result.timed_out).toBe(false);
  });

  it("kills an execution that exceeds the timeout", async () => {
    const result = await executeLocalCode({
      language: "python",
      code: "while True: pass",
      timeout_seconds: 1,
    }, auditStore);

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
  });

  it("rejects languages outside the server-side allowlist", async () => {
    await expect(executeLocalCode({ language: "bash", code: "echo no" }, auditStore))
      .rejects.toThrow(/allowlisted/i);
  });
});
