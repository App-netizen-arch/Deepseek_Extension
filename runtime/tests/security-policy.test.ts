import { describe, expect, it } from "vitest";
import { assertBoundAddress, assertLoopbackUrl, assertRequestOrigin, assertRiskAllowed, isSecretPath, policyDecision, securePath, secureUrl, assertBearerToken } from "../src/security-policy.js";

describe("shared security policy", () => {
  it("keeps paths inside the workspace and blocks secrets", () => {
    expect(() => securePath("../../etc/passwd")).toThrow();
    expect(() => securePath(".env")).toThrow();
    expect(() => securePath(".git/config")).toThrow();
    expect(securePath("src/index.ts")).toContain("src");
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("src/index.ts")).toBe(false);
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
    expect(assertLoopbackUrl("http://127.0.0.1:3037").hostname).toBe("127.0.0.1");
    expect(() => assertLoopbackUrl("http://localhost:3037")).toThrow();
  });

  it("applies risk-tier decisions", () => {
    expect(policyDecision("low")).toBe("allow");
    expect(policyDecision("medium")).toBe("allow");
    expect(policyDecision("high")).toBe("ask");
    expect(policyDecision("critical")).toBe("deny");
    expect(() => assertRiskAllowed("high")).toThrow(/requires explicit approval/);
    expect(() => assertRiskAllowed("high", true)).not.toThrow();
    expect(() => assertRiskAllowed("critical", true)).toThrow(/not automatically executable/);
  });

  it("accepts extension origins and rejects opaque/unknown origins", () => {
    expect(() => assertRequestOrigin("chrome-extension://example")).not.toThrow();
    expect(() => assertRequestOrigin("moz-extension://example")).not.toThrow();
    expect(() => assertRequestOrigin("null")).toThrow();
    expect(() => assertRequestOrigin("https://evil.example")).toThrow();
  });
});
