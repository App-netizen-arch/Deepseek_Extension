import { describe, expect, it } from "vitest";
import { securePath, secureUrl, assertBoundAddress, assertBearerToken } from "../src/security-policy.js";

describe("shared security policy", () => {
  it("keeps paths inside the workspace and blocks secrets", () => {
    expect(() => securePath("../../etc/passwd")).toThrow();
    expect(() => securePath(".env")).toThrow();
    expect(() => securePath(".git/config")).toThrow();
    expect(securePath("src/index.ts")).toContain("src");
  });
  it("rejects file and unsupported URL schemes", () => {
    expect(() => secureUrl("file:///etc/passwd")).toThrow();
    expect(() => secureUrl("ftp://example.com")).toThrow();
    expect(secureUrl("https://example.com").protocol).toBe("https:");
  });
  it("enforces the loopback and token boundaries", () => {
    expect(() => assertBoundAddress("0.0.0.0")).toThrow();
    expect(() => assertBoundAddress("127.0.0.1")).not.toThrow();
    expect(() => assertBearerToken("short")).toThrow();
    expect(() => assertBearerToken("x".repeat(32))).not.toThrow();
  });
});
