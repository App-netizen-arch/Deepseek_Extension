import { describe, expect, it } from "vitest";
import { BDS_PROTOCOL_VERSION, makeRequest, makeResponse, validateRequestEnvelope, isCanonicalBdsTag } from "../src/protocol-contract.js";

describe("canonical BDS protocol", () => {
  it("creates versioned request envelopes", () => {
    const request = makeRequest("req-1", "tags", { tags: [] }, { projectId: "demo" });
    expect(request.version).toBe(BDS_PROTOCOL_VERSION);
    expect(request.id).toBe("req-1");
    expect(request.type).toBe("tags");
    expect(request.projectId).toBe("demo");
    expect(Number.isSafeInteger(request.timestamp)).toBe(true);
  });

  it("validates the envelope boundary", () => {
    expect(() => validateRequestEnvelope({ version: 99, id: "x", type: "ping", timestamp: Date.now() })).toThrow("unsupported BDS protocol version");
    expect(() => validateRequestEnvelope({ version: BDS_PROTOCOL_VERSION, id: "", type: "ping", timestamp: Date.now() })).toThrow("invalid request id");
    expect(() => validateRequestEnvelope({ version: BDS_PROTOCOL_VERSION, id: "x", type: "ping", timestamp: Date.now() })).not.toThrow();
  });

  it("creates explicit success and error responses", () => {
    const ok = makeResponse("req-1", "runtime/status", true, { status: "ready" });
    expect(ok.ok).toBe(true);
    expect(ok.inReplyTo).toBe("req-1");
    expect(ok.payload).toEqual({ status: "ready" });

    const failed = makeResponse("req-2", "runtime/error", false, { code: "DENIED", message: "blocked" });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("DENIED");
  });

  it("recognizes canonical extension tags", () => {
    expect(isCanonicalBdsTag("LOCAL_EXEC")).toBe(true);
    expect(isCanonicalBdsTag("COWORK")).toBe(true);
    expect(isCanonicalBdsTag("NOT_A_BDS_TAG")).toBe(false);
  });
});
