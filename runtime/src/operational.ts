import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "./config.js";

const LOG_DIR = path.resolve(process.env.BDS_LOG_DIR ?? "./data/logs");
const LOG_FILE = path.join(LOG_DIR, "runtime.log");

export function log(level: "info"|"warn"|"error", message: string, fields: Record<string,unknown> = {}): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }) + "\n";
  fs.appendFileSync(LOG_FILE, line, "utf8");
  try { if (fs.statSync(LOG_FILE).size > LIMITS.maxMemoryBytes / 1024) rotateLogs(); } catch {}
}

function rotateLogs(): void {
  const backup = `${LOG_FILE}.1`;
  try { fs.rmSync(backup, { force: true }); fs.renameSync(LOG_FILE, backup); } catch {}
}

export function installProcessGuards(onShutdown: (signal:string)=>Promise<void>): void {
  let shuttingDown = false;
  const handler = (signal:string) => { if (shuttingDown) return; shuttingDown = true; onShutdown(signal).catch((e)=>{log("error","shutdown failed",{error:String(e)});process.exitCode=1;}); };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.on("uncaughtException", (e) => { log("error","uncaught exception",{error:String(e),stack:e.stack}); handler("uncaughtException"); });
  process.on("unhandledRejection", (e) => { log("error","unhandled rejection",{error:String(e)}); });
}
