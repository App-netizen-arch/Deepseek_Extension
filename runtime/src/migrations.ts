import Database from "better-sqlite3";

export interface Migration { version: number; name: string; sql: string; }
const MIGRATIONS: Migration[] = [
  { version: 1, name: "baseline", sql: "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);" },
  { version: 2, name: "runtime_indexes", sql: "CREATE INDEX IF NOT EXISTS idx_audit_task_created ON audit_events(task_id,created_at);" },
  { version: 3, name: "operational_state", sql: "CREATE TABLE IF NOT EXISTS runtime_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);" },
];

export function migrate(db: Database.Database): void {
  db.exec(MIGRATIONS[0].sql);
  const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{version:number}>;
  const seen = new Set(applied.map((r) => r.version));
  for (const migration of MIGRATIONS) {
    if (seen.has(migration.version)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version,migration.name,new Date().toISOString());
    });
    tx();
  }
}

export function schemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {version?:number} | undefined;
  return row?.version ?? 0;
}
