const STORAGE_KEY = "bdsRuntimeToken";
const DEFAULT_URL = "ws://127.0.0.1:3037/ws";
const DEFAULT_CODE_URL = "ws://127.0.0.1:3038/code/ws";

export class BdsRuntimeClient {
  #socket = null;
  #codeSocket = null;
  #connecting = null;
  #codeConnecting = null;
  #listeners = new Set();

  async setToken(token) { if (typeof token !== "string" || token.trim().length < 32) throw new Error("Runtime token is invalid"); await chrome.storage.local.set({ [STORAGE_KEY]: token.trim() }); }
  async getToken() { const result = await chrome.storage.local.get(STORAGE_KEY); return typeof result[STORAGE_KEY] === "string" ? result[STORAGE_KEY] : ""; }
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  async connect(url = DEFAULT_URL) {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connectSocket("#socket", url, "runtime");
    try { await this.#connecting; } finally { this.#connecting = null; }
  }
  async connectCode(url = DEFAULT_CODE_URL) {
    if (this.#codeSocket?.readyState === WebSocket.OPEN) return;
    if (this.#codeConnecting) return this.#codeConnecting;
    this.#codeConnecting = this.#connectSocket("#codeSocket", url, "code");
    try { await this.#codeConnecting; } finally { this.#codeConnecting = null; }
  }
  async #connectSocket(slot, url, kind) {
    const token = await this.getToken();
    if (!token) throw new Error("Runtime token is not configured");
    const socket = new WebSocket(url);
    if (slot === "#socket") this.#socket = socket; else this.#codeSocket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} runtime connection timeout`)), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); socket.send(JSON.stringify({ type: "auth", token })); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${kind} runtime connection failed`)); }, { once: true });
    });
    socket.addEventListener("message", (event) => { try { const message=JSON.parse(event.data); for(const listener of this.#listeners) listener(message); } catch {} });
    socket.addEventListener("close", () => { if (slot === "#socket" && this.#socket === socket) this.#socket = null; if (slot === "#codeSocket" && this.#codeSocket === socket) this.#codeSocket = null; });
  }
  async request(message) { await this.connect(); if(!this.#socket || this.#socket.readyState!==WebSocket.OPEN) throw new Error("Runtime is offline"); this.#socket.send(JSON.stringify(message)); }
  async requestCode(message) { await this.connectCode(); if(!this.#codeSocket || this.#codeSocket.readyState!==WebSocket.OPEN) throw new Error("Code Agent is offline"); this.#codeSocket.send(JSON.stringify(message)); }
  async status() { const token=await this.getToken(); if(!token)return{ok:false,status:"unconfigured"}; try{const response=await fetch("http://127.0.0.1:3037/v1/status",{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)return{ok:false,status:`http_${response.status}`};return await response.json();}catch(error){return{ok:false,status:"offline",error:String(error?.message||error)};} }
  async codeStatus(){const token=await this.getToken();if(!token)return{ok:false,status:"unconfigured"};try{const response=await fetch("http://127.0.0.1:3038/code/health",{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)return{ok:false,status:`http_${response.status}`};return await response.json();}catch(error){return{ok:false,status:"offline",error:String(error?.message||error)};}}
  close(){this.#socket?.close(1000,"client shutdown");this.#codeSocket?.close(1000,"client shutdown");this.#socket=null;this.#codeSocket=null;}
}
