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
    `);
  }

  audit(eventType: string, payload: unknown): void {
    const serialized = JSON.stringify(payload).slice(0, LIMITS.auditPayloadBytes);
    this.db.prepare("INSERT INTO audit_events(created_at,event_type,payload) VALUES(?,?,?)")
      .run(new Date().toISOString(), eventType, serialized);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
    if (count.count > LIMITS.maxAuditRows) {
      this.db.prepare("DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT ?)").run(LIMITS.maxAuditRows);
    }
  }

  close(): void { this.db.close(); }
}
