import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, WORKSPACE } from "./config.js";

export type MemoryModule = "web" | "code" | "math" | "shared";
export type MemoryType = "fact" | "file" | "citation" | "decision" | "mathir";
export interface MemoryRecord { id:string; project_id:string; module:MemoryModule; memory_type:MemoryType; key:string; value:string; timestamp:string; confidence:number; source?:string; updated_at:string; }
export interface ProjectRecord { id:string; name:string; workspace_path?:string; created_at:string; updated_at:string; }

const MAX_CONTEXT = 20;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET = /(^|[\\/])(?:\.env(?:\.[^/]+)?|id_rsa|id_ed25519|credentials\.json|.*\.pem)$/i;
function keyBytes():Buffer { const configured=process.env.BDS_MEMORY_KEY; if(configured){const raw=Buffer.from(configured,"base64");if(raw.length===32)return raw;return crypto.createHash("sha256").update(configured).digest();} const state=path.resolve(`${DB_PATH}.memory-key`); if(fs.existsSync(state)){const raw=fs.readFileSync(state);if(raw.length===32)return raw;} const raw=crypto.randomBytes(32);fs.writeFileSync(state,raw,{mode:0o600});return raw; }
const KEY=keyBytes();
function seal(value:string):string { const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv("aes-256-gcm",KEY,iv);const data=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString("base64"); }
function open(value:string):string { const raw=Buffer.from(value,"base64");const decipher=crypto.createDecipheriv("aes-256-gcm",KEY,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString("utf8"); }
function assertSafe(value:string){if(SECRET.test(value))throw new Error("secret-like memory is not permitted");}

export class ProjectMemoryStore {
  private readonly db:Database.Database;
  constructor(){this.db=new Database(DB_PATH);this.db.pragma("journal_mode=WAL");this.db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,module TEXT NOT NULL,memory_type TEXT NOT NULL,key TEXT NOT NULL,value_ciphertext TEXT NOT NULL,timestamp TEXT NOT NULL,confidence REAL NOT NULL,source_ciphertext TEXT,updated_at TEXT NOT NULL,UNIQUE(project_id,module,memory_type,key));CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);`);}
  audit(type:string,payload:unknown){this.db.prepare("INSERT INTO audit_events(created_at,event_type,payload) VALUES(?,?,?)").run(new Date().toISOString(),type,JSON.stringify(payload).slice(0,20000));}
  createProject(name:string,workspacePath=WORKSPACE):ProjectRecord{const id=`project_${crypto.randomUUID().replaceAll("-","").slice(0,16)}`;const now=new Date().toISOString();this.db.prepare("INSERT INTO projects(id,name,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?)").run(id,name,workspacePath,now,now);return{id,name,workspace_path:workspacePath,created_at:now,updated_at:now};}
  listProjects(){return this.db.prepare("SELECT id,name,workspace_path,created_at,updated_at FROM projects ORDER BY updated_at DESC").all() as ProjectRecord[];}
  getProject(id:string){return this.db.prepare("SELECT id,name,workspace_path,created_at,updated_at FROM projects WHERE id=?").get(id) as ProjectRecord|undefined;}
  deleteProject(id:string){this.db.transaction(()=>{this.db.prepare("DELETE FROM memories WHERE project_id=?").run(id);this.db.prepare("DELETE FROM projects WHERE id=?").run(id);})();}
  write(projectId:string,input:{module:MemoryModule;type:MemoryType;key:string;value:string;confidence?:number;source?:string;}){const project=this.getProject(projectId);if(!project)throw new Error("project_not_found");assertSafe(input.key);assertSafe(input.value);if(input.source)assertSafe(input.source);const now=new Date().toISOString();const id=`mem_${crypto.randomUUID().replaceAll("-","").slice(0,16)}`;this.db.prepare(`INSERT INTO memories(id,project_id,module,memory_type,key,value_ciphertext,timestamp,confidence,source_ciphertext,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,module,memory_type,key) DO UPDATE SET value_ciphertext=excluded.value_ciphertext,timestamp=excluded.timestamp,confidence=excluded.confidence,source_ciphertext=excluded.source_ciphertext,updated_at=excluded.updated_at`).run(id,projectId,input.module,input.type,input.key,seal(input.value),now,Math.max(0,Math.min(1,input.confidence??1)),input.source?seal(input.source):null,now);this.audit("memory.write",{project_id:projectId,module:input.module,type:input.type,key:input.key});return{id,status:"stored"};}
  list(projectId:string,module?:MemoryModule,limit=100):MemoryRecord[]{const rows=this.db.prepare(`SELECT id,project_id,module,memory_type,key,value_ciphertext,timestamp,confidence,source_ciphertext,updated_at FROM memories WHERE project_id=? ${module?"AND module=?":""} ORDER BY updated_at DESC LIMIT ?`).all(...(module?[projectId,module,Math.min(100,limit)]:[projectId,Math.min(100,limit)])) as any[];const now=Date.now();const out=rows.map(r=>({...r,value:open(r.value_ciphertext),source:r.source_ciphertext?open(r.source_ciphertext):undefined}));this.audit("memory.read",{project_id:projectId,count:out.length});return out.map(r=>({...r,stale:now-Date.parse(r.timestamp)>STALE_MS}));}
  search(projectId:string,q:string,maxResults=20):MemoryRecord[]{const terms=q.toLowerCase().split(/\s+/).filter(Boolean).slice(0,12);const all=this.list(projectId,undefined,100);const scored=all.map(m=>{const hay=`${m.key} ${m.value} ${m.source??""}`.toLowerCase();const score=terms.length?terms.filter(t=>hay.includes(t)).length/terms.length:0;return{m,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,Math.min(MAX_CONTEXT,maxResults)).map(x=>x.m);this.audit("memory.search",{project_id:projectId,query:q,count:scored.length});return scored;}
  delete(projectId:string,id:string){const changed=this.db.prepare("DELETE FROM memories WHERE project_id=? AND id=?").run(projectId,id).changes;this.audit("memory.delete",{project_id:projectId,memory_id:id});return changed>0;}
  close(){this.db.close();}
}

export function memoryContext(records:MemoryRecord[]):string { return `[MEMORY]\n${records.slice(0,MAX_CONTEXT).map(r=>`- ${r.module}/${r.memory_type} ${r.key}: ${r.value}${r.source?` (source: ${r.source})`:""}${r.stale?" [stale]":""}`).join("\n")}\n[/MEMORY]`; }
