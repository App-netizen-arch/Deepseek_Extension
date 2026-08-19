import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, LIMITS } from "./config.js";

export class RuntimeStore {
  readonly db: Database.Database;
  constructor() {
    fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        checkpoint_json TEXT,
        result_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        name TEXT PRIMARY KEY,
        state_ciphertext TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  audit(eventType: string, payload: unknown): void {
    const serialized = JSON.stringify(payload).slice(0, LIMITS.auditPayloadBytes);
    this.db.prepare("INSERT INTO audit_events(created_at,event_type,payload) VALUES(?,?,?)").run(new Date().toISOString(), eventType, serialized);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
    if (count.count > LIMITS.maxAuditRows) this.db.prepare("DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT ?)").run(LIMITS.maxAuditRows);
  }
  getAuditEventsForTask(taskId: string, limit = 500): Array<{ id: number; created_at: string; event_type: string; payload: unknown }> {
    const rows = this.db.prepare("SELECT id,created_at,event_type,payload FROM audit_events ORDER BY id DESC LIMIT ?").all(Math.min(limit, 1000)) as Array<{ id:number; created_at:string; event_type:string; payload:string }>;
    return rows.filter((row) => row.payload.includes(taskId)).map((row) => ({ ...row, payload: (() => { try { return JSON.parse(row.payload); } catch { return row.payload; } })() }));
  }
  isLanguageEnabled(language: string): boolean {
    const row = this.db.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(`language:${language}`) as { value?: string } | undefined;
    return row?.value === "enabled";
  }
  setLanguageEnabled(language: string, enabled: boolean): void {
    this.db.prepare("INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`language:${language}`, enabled ? "enabled" : "disabled");
    this.audit("code.language.policy", { language, enabled });
  }
  listLanguagePolicies(languages: readonly string[]): Record<string, boolean> { return Object.fromEntries(languages.map((language) => [language, this.isLanguageEnabled(language)])); }
  upsertWebTask(id: string, status: string, request: unknown, checkpoint?: unknown, result?: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO web_tasks(id,status,request_json,checkpoint_json,result_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, request_json=excluded.request_json, checkpoint_json=excluded.checkpoint_json, result_json=excluded.result_json, updated_at=excluded.updated_at`).run(id, status, JSON.stringify(request), checkpoint == null ? null : JSON.stringify(checkpoint), result == null ? null : JSON.stringify(result), now);
  }
  getWebTask(id: string): { id: string; status: string; request: any; checkpoint: any; result: any } | undefined {
    const row = this.db.prepare("SELECT * FROM web_tasks WHERE id=?").get(id) as any;
    if (!row) return undefined;
    return { id: row.id, status: row.status, request: JSON.parse(row.request_json), checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null };
  }
  listWebTasks(limit = 100): Array<{ id: string; status: string; updated_at: string }> { return this.db.prepare("SELECT id,status,updated_at FROM web_tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as any; }
  upsertWebSession(name: string, stateCiphertext: string, expiresAt: string): void { const now = new Date().toISOString(); this.db.prepare(`INSERT INTO web_sessions(name,state_ciphertext,expires_at,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state_ciphertext=excluded.state_ciphertext,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(name, stateCiphertext, expiresAt, now, now); }
  getWebSession(name: string): { name: string; state_ciphertext: string; expires_at: string } | undefined { return this.db.prepare("SELECT name,state_ciphertext,expires_at FROM web_sessions WHERE name=?").get(name) as any; }
  listWebSessions(): Array<{ name: string; expires_at: string }> { return this.db.prepare("SELECT name,expires_at FROM web_sessions ORDER BY name").all() as any; }
  deleteWebSession(name: string): boolean { return this.db.prepare("DELETE FROM web_sessions WHERE name=?").run(name).changes > 0; }
  createApproval(id: string, taskId: string, action: string, target: string, expiresAt: string): void { const now = new Date().toISOString(); this.db.prepare("INSERT INTO approvals(id,task_id,action,target,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?, 'pending',?,?)").run(id, taskId, action, target, expiresAt, now, now); }
  getApproval(id: string): any { return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id); }
  decideApproval(id: string, status: "approved" | "denied"): boolean { return this.db.prepare("UPDATE approvals SET status=?,updated_at=? WHERE id=? AND status='pending'").run(status, new Date().toISOString(), id).changes > 0; }
  close(): void { this.db.close(); }
}
