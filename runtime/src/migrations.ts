import Database from "better-sqlite3";
export interface Migration{version:number;name:string;sql:string;}
const MIGRATIONS:Migration[]=[
 {version:1,name:"baseline",sql:"CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);"},
 {version:2,name:"runtime_indexes",sql:"ALTER TABLE audit_events ADD COLUMN task_id TEXT;CREATE INDEX IF NOT EXISTS idx_audit_task_created ON audit_events(task_id,created_at);"},
 {version:3,name:"operational_state",sql:"CREATE TABLE IF NOT EXISTS runtime_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);"},
 {version:4,name:"agent_core",sql:`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  parent_id TEXT,
  project_id TEXT,
  session_id TEXT,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'queued',
  retries INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_ready ON tasks(status, priority DESC, scheduled_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id, status);
`},
 {version:5,name:"workflow_runs",sql:`
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  definition_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '{}',
  step_states_json TEXT NOT NULL DEFAULT '{}',
  agent_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, updated_at DESC);
`},
 {version:6,name:"permission_rules",sql:`
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  tool TEXT NOT NULL,
  path_pattern TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('allow','deny','ask')),
  granted_by TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permissions_lookup ON permissions(agent_id, tool);
`},
];
export function migrate(db:Database.Database):void{db.exec(MIGRATIONS[0].sql);const applied=db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{version:number}>;const seen=new Set(applied.map(r=>r.version));for(const migration of MIGRATIONS){if(seen.has(migration.version))continue;const tx=db.transaction(()=>{db.exec(migration.sql);db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version,migration.name,new Date().toISOString());});try{tx();}catch(error){if(migration.version===2&&String(error).includes("duplicate column name")){db.exec("CREATE INDEX IF NOT EXISTS idx_audit_task_created ON audit_events(task_id,created_at);");db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version,migration.name,new Date().toISOString());}else throw error;}}}
export function schemaVersion(db:Database.Database):number{const row=db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {version?:number}|undefined;return row?.version??0;}
