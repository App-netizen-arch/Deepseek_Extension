import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateBearer } from "./auth.js";
import { HOST, LIMITS, PORT, TOKEN } from "./config.js";
import { RuntimeStore } from "./store.js";
import { ALLOWED_PHASE0_TAGS, type WsEvent, type WsHello } from "./protocol.js";
import { parseBdsTags } from "./tag-parser.js";

const store = new RuntimeStore();
const startedAt = Date.now();
const clients = new Set<WebSocket>();
const authenticated = new WeakSet<WebSocket>();

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMITS.httpBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(event: WsEvent): void {
  const encoded = JSON.stringify(event);
  for (const client of clients) {
    if (authenticated.has(client) && client.readyState === client.OPEN) client.send(encoded);
  }
}

function sendStatus(socket: WebSocket): void {
  socket.send(JSON.stringify({ type: "runtime/status", payload: { status: "ready", phase: 0 } } satisfies WsEvent));
}

export function createRuntimeServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/v1/health") {
      json(res, 200, { ok: true, service: "better-deepseek-local-runtime", host: HOST, port: PORT, uptimeMs: Date.now() - startedAt });
      return;
    }

    if (!authenticateBearer(req.headers.authorization, TOKEN)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/v1/status") {
        json(res, 200, { ok: true, status: "ready", phase: 0, clients: clients.size });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/tags/parse") {
        const body = JSON.parse(await readBody(req)) as { text?: string };
        const text = typeof body.text === "string" ? body.text : "";
        const tags = parseBdsTags(text);
        const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name);
        store.audit("tags.parse", { count: tags.length, unsupported });
        json(res, 200, { ok: true, tags, unsupported });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/audit") {
        const body = JSON.parse(await readBody(req)) as { eventType?: string; payload?: unknown };
        if (!body.eventType || typeof body.eventType !== "string") {
          json(res, 400, { ok: false, error: "eventType is required" });
          return;
        }
        store.audit(body.eventType, body.payload ?? null);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      json(res, 400, { ok: false, error: message });
    }
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes });
  wsServer.on("connection", (socket) => {
    clients.add(socket);
    let authed = false;
    const timeout = setTimeout(() => {
      if (!authed) socket.close(1008, "authentication required");
    }, 5000);

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as WsHello | { type: string; requestId?: string; payload?: unknown };
        if (!authed) {
          if (message.type !== "auth" || typeof (message as WsHello).token !== "string") {
            socket.close(1008, "authentication required");
            return;
          }
          if (!authenticateBearer(`Bearer ${(message as WsHello).token}`, TOKEN)) {
            store.audit("ws.auth.failure", {});
            socket.close(1008, "invalid token");
            return;
          }
          authed = true;
          authenticated.add(socket);
          clearTimeout(timeout);
          store.audit("ws.auth.success", {});
          sendStatus(socket);
          return;
        }

        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "runtime/pong", requestId: (message as { requestId?: string }).requestId } satisfies WsEvent));
          return;
        }

        if (message.type === "status") {
          sendStatus(socket);
          return;
        }

        if (message.type === "tags") {
          const payload = (message as { payload?: { text?: string } }).payload ?? {};
          const text = typeof payload.text === "string" ? payload.text : "";
          const tags = parseBdsTags(text);
          const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name);
          store.audit("tags.detected", { count: tags.length, unsupported });
          socket.send(JSON.stringify({ type: "runtime/tags", payload: { tags, unsupported } } satisfies WsEvent));
          return;
        }

        store.audit("ws.message.unsupported", { type: message.type });
        socket.send(JSON.stringify({ type: "runtime/error", payload: { message: `unsupported message: ${message.type}` } } satisfies WsEvent));
      } catch {
        socket.close(1007, "invalid message");
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  });

  server.on("close", () => {
    wsServer.close();
    for (const client of clients) client.close();
    store.close();
  });

  return server;
}
