const STORAGE_KEY = "bdsRuntimeToken";
const DEFAULT_URL = "ws://127.0.0.1:3037/ws";

export class BdsRuntimeClient {
  #socket = null;
  #connecting = null;
  #listeners = new Set();
  #pending = new Map();

  async setToken(token) {
    if (typeof token !== "string" || token.trim().length < 32) throw new Error("Runtime token is invalid");
    await chrome.storage.local.set({ [STORAGE_KEY]: token.trim() });
  }

  async getToken() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return typeof result[STORAGE_KEY] === "string" ? result[STORAGE_KEY] : "";
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(url = DEFAULT_URL) {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const token = await this.getToken();
      if (!token) throw new Error("Runtime token is not configured");
      const socket = new WebSocket(url);
      this.#socket = socket;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Runtime connection timeout")), 5000);
        socket.addEventListener("open", () => {
          clearTimeout(timer);
          socket.send(JSON.stringify({ type: "auth", token }));
          resolve();
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("Runtime connection failed"));
        }, { once: true });
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          const requestId = message?.requestId;
          if (requestId && this.#pending.has(requestId)) {
            const pending = this.#pending.get(requestId);
            this.#pending.delete(requestId);
            pending.resolve(message);
          }
          for (const listener of this.#listeners) listener(message);
        } catch {
          // Ignore malformed runtime events.
        }
      });
      socket.addEventListener("close", () => {
        if (this.#socket === socket) this.#socket = null;
        for (const [requestId, pending] of this.#pending) {
          pending.reject(new Error("Runtime connection closed"));
          this.#pending.delete(requestId);
        }
      });
    })();
    try { await this.#connecting; } finally { this.#connecting = null; }
  }

  async request(message) {
    await this.connect();
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Runtime is offline");
    this.#socket.send(JSON.stringify(message));
  }

  async requestAndWait(message, timeoutMs = 5000) {
    const requestId = message.requestId || crypto.randomUUID();
    await this.connect();
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Runtime is offline");
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.#pending.delete(requestId);
        fn(value);
      };
      const off = this.onEvent((event) => {
        if (event?.requestId === requestId || (message.type === "math/analyze" && event?.type === "math/result")) finish(resolve, event);
        else if (message.type === "math/analyze" && event?.type === "runtime/error") finish(reject, new Error(event?.payload?.message || "MathBridge error"));
      });
      const timer = setTimeout(() => finish(reject, new Error("Runtime request timed out")), timeoutMs);
      this.#pending.set(requestId, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      this.#socket.send(JSON.stringify({ ...message, requestId }));
    });
  }

  async status() {
    const token = await this.getToken();
    if (!token) return { ok: false, status: "unconfigured" };
    try {
      const response = await fetch("http://127.0.0.1:3037/v1/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return { ok: false, status: `http_${response.status}` };
      return await response.json();
    } catch (error) {
      return { ok: false, status: "offline", error: String(error?.message || error) };
    }
  }

  close() {
    this.#socket?.close(1000, "client shutdown");
    this.#socket = null;
    for (const [requestId, pending] of this.#pending) {
      pending.reject(new Error("Runtime client closed"));
      this.#pending.delete(requestId);
    }
  }
}
