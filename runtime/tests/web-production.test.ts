import { describe, expect, it } from "vitest";
import { domainAllowed, normalizeProductionRequest } from "../src/web-production.js";

describe("production web policy", () => {
  it("defaults to read-only and caps budgets", () => {
    const request = normalizeProductionRequest({ goal: "research", max_pages: 999, max_depth: 99, time_budget_minutes: 99 });
    expect(request.interaction_level).toBe("read-only");
    expect(request.max_pages).toBe(25);
    expect(request.max_depth).toBe(3);
    expect(request.time_budget_minutes).toBe(20);
  });

  it("allows only explicitly permitted domains", () => {
    expect(domainAllowed("docs.example.com", ["example.com"], [])).toBe(true);
    expect(domainAllowed("evil.example.net", ["example.com"], [])).toBe(false);
    expect(domainAllowed("private.example.com", [], ["example.com"])).toBe(false);
  });

  it("preserves the fill-forms approval level instead of silently changing it", () => {
    const request = normalizeProductionRequest({ goal: "search", interaction_level: "fill-forms" });
    expect(request.interaction_level).toBe("fill-forms");
  });
});
