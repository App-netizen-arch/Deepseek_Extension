const DEFAULT_RUNTIME = { http: "http://127.0.0.1:3037", ws: "ws://127.0.0.1:3037/ws", codeWs: "ws://127.0.0.1:3038/code/ws", controlHttp: "http://127.0.0.1:3039", controlWs: "ws://127.0.0.1:3039/control/ws" };
let state = { connected: false, lastError: null, runtime: DEFAULT_RUNTIME };
let sockets = new Map();

async function settings() {
  const v = await chrome.storage.local.get({ token: "", runtime: DEFAULT_RUNTIME });
  state.runtime = { ...DEFAULT_RUNTIME, ...(v.runtime || {}) };
  return v;
}

function closeSockets() {
  for (const ws of sockets.values()) { try { ws.close(); } catch {} }
  sockets.clear();
}

function connect(kind, url, onMessage) {
  const existing = sockets.get(kind);
  if (existing && existing.readyState <= WebSocket.OPEN) return existing;
  const ws = new WebSocket(url);
  sockets.set(kind, ws);
  ws.onopen = () => { state.connected = true; state.lastError = null; chrome.runtime.sendMessage({ type: "runtime/status", state }).catch(() => {}); };
  ws.onmessage = (event) => { try { onMessage(JSON.parse(event.data)); } catch { state.lastError = "invalid runtime message"; } };
  ws.onerror = () => { state.lastError = `runtime websocket error: ${kind}`; };
  ws.onclose = () => { if (sockets.get(kind) === ws) sockets.delete(kind); state.connected = sockets.size > 0; chrome.runtime.sendMessage({ type: "runtime/status", state }).catch(() => {}); };
  return ws;
}

async function runtimeFetch(path, init = {}) {
  const { token } = await settings();
  if (!token || token.length < 32) throw new Error("Runtime token is not configured");
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Cache-Control", "no-store");
  const response = await fetch(`${state.runtime.http}${path}`, { ...init, headers });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body.error || `Runtime HTTP ${response.status}`);
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === "runtime/config") { await settings(); sendResponse({ ok: true, runtime: state.runtime }); return; }
      if (message?.type === "runtime/status") { sendResponse({ ok: true, state }); return; }
      if (message?.type === "runtime/fetch") { sendResponse({ ok: true, body: await runtimeFetch(message.path, message.init || {}) }); return; }
      if (message?.type === "runtime/tag") {
        const { token } = await settings();
        if (!token || token.length < 32) throw new Error("Runtime token is not configured");
        const tag = message.tag;
        const url = tag?.name === "CODE_AGENT" ? state.runtime.codeWs : tag?.name?.startsWith("MEMORY_") || tag?.name === "PROJECT_CONTEXT" || tag?.name === "WORKFLOW" || tag?.name === "AGENT_DEFINE" || tag?.name === "SUBAGENT" || tag?.name === "MCP_MANAGE" ? state.runtime.controlWs : state.runtime.ws;
        const kind = tag?.name === "CODE_AGENT" ? "code" : url === state.runtime.controlWs ? "control" : "runtime";
        const ws = connect(kind, url, (event) => chrome.tabs.sendMessage(message.tabId, { type: "runtime/event", event }).catch(() => {}));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "bds/tag", tag }));
        else ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "bds/tag", tag })), { once: true });
        sendResponse({ ok: true, queued: true });
        return;
      }
      sendResponse({ ok: false, error: "unsupported message" });
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(() => { closeSockets(); settings().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => settings().catch(() => {}));
