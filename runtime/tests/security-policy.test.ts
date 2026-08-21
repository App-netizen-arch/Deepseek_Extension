import { describe, expect, it } from "vitest";
import { assertBearerToken, assertBoundAddress, assertLoopbackUrl, assertRequestOrigin, assertRiskAllowed, policyDecision, securePath, secureUrl } from "../src/security-policy.js";

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
    expect(() => assertLoopbackUrl("http://127.0.0.1:3037/health")).not.toThrow();
    expect(() => assertLoopbackUrl("https://127.0.0.1:3037/health")).toThrow();
    expect(() => assertLoopbackUrl("http://localhost:3037/health")).toThrow();
  });

  it("enforces the loopback and token boundaries", () => {
    expect(() => assertBoundAddress("0.0.0.0")).toThrow();
    expect(() => assertBoundAddress("127.0.0.1")).not.toThrow();
    expect(() => assertBearerToken("short")).toThrow();
    expect(() => assertBearerToken("x".repeat(32))).not.toThrow();
  });

  it("enforces the shared risk tiers", () => {
    expect(policyDecision("low")).toBe("allow");
    expect(policyDecision("medium")).toBe("allow");
    expect(policyDecision("high")).toBe("ask");
    expect(policyDecision("critical")).toBe("deny");
    expect(() => assertRiskAllowed("low")).not.toThrow();
    expect(() => assertRiskAllowed("high")).toThrow(/requires explicit approval/);
    expect(() => assertRiskAllowed("high", true)).not.toThrow();
    expect(() => assertRiskAllowed("critical", true)).toThrow(/not automatically executable/);
  });

  it("accepts browser-extension origins and rejects opaque or unknown origins", () => {
    expect(() => assertRequestOrigin(undefined)).not.toThrow();
    expect(() => assertRequestOrigin("chrome-extension://example")).not.toThrow();
    expect(() => assertRequestOrigin("moz-extension://example")).not.toThrow();
    expect(() => assertRequestOrigin("http://127.0.0.1")).not.toThrow();
    expect(() => assertRequestOrigin("null")).toThrow();
    expect(() => assertRequestOrigin("https://attacker.example")).toThrow();
    expect(() => assertRequestOrigin("https://custom.example", ["https://custom.example"])).not.toThrow();
  });
});
