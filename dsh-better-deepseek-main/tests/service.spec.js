import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import BetterDeepSeekBridgeService from "../src/index.js";
let ctx;
afterEach(async () => {
    if (ctx !== undefined) {
        await ctx.fiber.dispose();
        ctx = undefined;
    }
});
describe('BetterDeepSeekBridgeService', () => {
    it('registers ping endpoint and returns status with CORS headers', async () => {
        ctx = new Context();
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
        await ctx.plugin(BetterDeepSeekBridgeService, { enableCors: true });
        const port = ctx.webServer.port;
        const pingRes = await fetch(`http://127.0.0.1:${String(port)}/api/better-deepseek/ping`);
        expect(pingRes.status).toBe(200);
        expect(pingRes.headers.get('access-control-allow-origin')).toBe('*');
        const body = await pingRes.json();
        expect(body).toMatchObject({
            active: true,
            version: '1.6.0',
            capabilities: ['filtered_sse', 'approvals', 'rag_inject'],
        });
    });
    it('handles CORS OPTIONS preflight request', async () => {
        ctx = new Context();
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
        await ctx.plugin(BetterDeepSeekBridgeService, { enableCors: true });
        const port = ctx.webServer.port;
        const preflightRes = await fetch(`http://127.0.0.1:${String(port)}/api/better-deepseek/ping`, {
            method: 'OPTIONS',
        });
        expect(preflightRes.status).toBe(204);
        expect(preflightRes.headers.get('access-control-allow-origin')).toBe('*');
        expect(preflightRes.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    });
    it('opens SSE event stream endpoint', async () => {
        ctx = new Context();
        await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
        await ctx.plugin(BetterDeepSeekBridgeService, { enableCors: true });
        const port = ctx.webServer.port;
        const controller = new AbortController();
        const sseRes = await fetch(`http://127.0.0.1:${String(port)}/api/better-deepseek/events`, {
            signal: controller.signal,
        });
        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
        controller.abort();
    });
});
//# sourceMappingURL=service.spec.js.map