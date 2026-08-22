/**
 * BDS local-runtime client (Phase F approvals).
 *
 * The content script cannot talk to http://127.0.0.1 directly under page
 * CSP, so approval polling and decisions are proxied through the service
 * worker, which has <all_urls> host permissions.
 *
 * Configuration lives in chrome.storage.local:
 *   bdsRuntimeUrl   default "http://127.0.0.1:3037"
 *   bdsRuntimeToken required bearer token (>= 32 chars)
 */

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:3037";

async function getRuntimeConfig() {
  const stored = await chrome.storage.local.get(["bdsRuntimeUrl", "bdsRuntimeToken"]);
  const url = String(stored.bdsRuntimeUrl || "").trim().replace(/\/+$/, "") || DEFAULT_RUNTIME_URL;
  const token = String(stored.bdsRuntimeToken || "").trim();
  return { url, token };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fetch the runtime's pending approvals; null when unreachable/unconfigured. */
export async function listPendingApprovals() {
  const { url, token } = await getRuntimeConfig();
  if (!token) return { ok: false, configured: false, error: "BDS runtime token is not set" };
  try {
    const resp = await fetch(`${url}/approvals/pending`, { headers: authHeaders(token) });
    if (resp.status === 401) return { ok: false, configured: true, error: "runtime rejected the token" };
    if (!resp.ok) return { ok: false, configured: true, error: `runtime returned ${resp.status}` };
    const data = await resp.json();
    return { ok: true, configured: true, approvals: Array.isArray(data.approvals) ? data.approvals : [] };
  } catch (error) {
    return { ok: false, configured: true, error: String(error && error.message ? error.message : error) };
  }
}

/** Submit an approve/deny decision for one approval id. */
export async function decideApproval(id, decision) {
  const { url, token } = await getRuntimeConfig();
  if (!token) return { ok: false, error: "BDS runtime token is not set" };
  if (!id || (decision !== "approved" && decision !== "denied")) {
    return { ok: false, error: "id and decision (approved|denied) are required" };
  }
  try {
    const resp = await fetch(`${url}/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: Boolean(data.ok), status: resp.status, error: data.error };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/** List known agents (for the status panel); null-ish results on failure. */
export async function listAgents(filters = {}) {
  const { url, token } = await getRuntimeConfig();
  if (!token) return { ok: false, configured: false, error: "BDS runtime token is not set" };
  try {
    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    const qs = params.toString();
    const resp = await fetch(`${url}/v1/agents${qs ? `?${qs}` : ""}`, { headers: authHeaders(token) });
    if (resp.status === 401) return { ok: false, configured: true, error: "runtime rejected the token" };
    if (!resp.ok) return { ok: false, configured: true, error: `runtime returned ${resp.status}` };
    const data = await resp.json();
    return { ok: true, configured: true, agents: Array.isArray(data.agents) ? data.agents : [] };
  } catch (error) {
    return { ok: false, configured: true, error: String(error && error.message ? error.message : error) };
  }
}

/** Unauthenticated health probe used by the settings "Test connection" button. */
export async function pingRuntime() {
  const { url } = await getRuntimeConfig();
  try {
    const resp = await fetch(`${url}/health`);
    if (!resp.ok) return { ok: false, error: `runtime returned ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    return { ok: true, service: data.service || "runtime", url };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function runtimeJson(method, path, body) {
  const { url, token } = await getRuntimeConfig();
  if (!token) return { ok: false, error: "BDS_RUNTIME_TOKEN is not set — configure it in BDS settings" };
  try {
    const resp = await fetch(`${url}${path}`, {
      method,
      headers: { ...authHeaders(token), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      return { ok: false, status: resp.status, error: data.error || `runtime returned ${resp.status}` };
    }
    return { ok: true, ...data };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/** Spawn an agent; when `task` is provided the runtime starts it immediately. */
export async function spawnRuntimeAgent(spec = {}) {
  const body = {};
  if (spec.name) body.name = spec.name;
  if (spec.type) body.type = spec.type;
  if (spec.task) body.task = { instruction: spec.task };
  if (spec.parentId) body.parentId = spec.parentId;
  return runtimeJson("POST", "/v1/agent/spawn", body);
}

/** Full status snapshot for one agent. */
export async function fetchAgentStatus(agentId) {
  if (!agentId) return { ok: false, error: "agent id is required" };
  return runtimeJson("GET", `/v1/agent/${encodeURIComponent(agentId)}/status`);
}

/** Cancel an agent and its subtree. */
export async function cancelRuntimeAgent(agentId) {
  if (!agentId) return { ok: false, error: "agent id is required" };
  return runtimeJson("POST", `/v1/agent/${encodeURIComponent(agentId)}/cancel`);
}
