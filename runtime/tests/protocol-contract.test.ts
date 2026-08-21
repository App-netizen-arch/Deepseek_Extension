import { describe, expect, it } from "vitest";
import { ALLOWED_PHASE0_TAGS, BDS_PROTOCOL_VERSION, CANONICAL_BDS_TAGS, makeRequest, makeResponse, validateRequestEnvelope } from "../src/protocol-contract.js";

describe("BDS protocol contract", () => {
  it("exposes protocol version and canonical tags", () => {
    expect(BDS_PROTOCOL_VERSION).toBe(1);
    expect(CANONICAL_BDS_TAGS).toContain("COWORK");
    expect(CANONICAL_BDS_TAGS).toContain("CODE_PANEL");
    expect(CANONICAL_BDS_TAGS).toContain("CHAT_CLEAN");
    expect(ALLOWED_PHASE0_TAGS.has("COWORK")).toBe(true);
  });

  it("creates and validates versioned request envelopes", () => {
    const request = makeRequest("req-1", "tags", { text: "BDS:LOCAL_EXEC" }, { sessionId: "s1", projectId: "p1" });
    expect(request.version).toBe(1);
    expect(request.id).toBe("req-1");
    expect(request.sessionId).toBe("s1");
    expect(() => validateRequestEnvelope(request)).not.toThrow();
  });

  it("creates success and error responses", () => {
    const success = makeResponse("req-1", "runtime/status", true, { ready: true });
    const failure = makeResponse("req-1", "runtime/error", false, { code: "ERR", message: "failed" });
    expect(success.ok).toBe(true);
    expect(success.inReplyTo).toBe("req-1");
    expect(failure.ok).toBe(false);
    expect(failure.error?.code).toBe("ERR");
  });
});
