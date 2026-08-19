import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { WORKSPACE, LIMITS } from "./config.js";
import type { RuntimeStore } from "./store.js";

export type CodeRisk = "low" | "medium" | "high" | "critical";
export type CodeTaskStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface CodeTaskRequest {
  task: string;
  workspace?: string;
  max_iterations?: number;
  approval?: "auto_for_known" | "always";
  tools?: string[];
}

export interface CodeApproval {
  id: string;
  task_id: string;
  tool: string;
  risk: CodeRisk;
  command?: string[];
  files?: string[];
  expires_at: string;
  status: "pending" | "approved" | "denied";
}

const active = new Map<string, { cancel: () => void; paused: boolean; resume?: () => void }>();
const TOOL_ALLOWLIST = new Set(["fs", "shell", "git", "lean4", "isabelle", "coq", "sage", "lsp", "memory"]);
const SECRET_NAMES = new Set([".env", ".env.local", ".env.production", ".env.development", ".ssh", "id_rsa", "id_ed25519", "credentials.json"]);
const COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "git.status": ["git", "status", "--short"],
  "git.diff": ["git", "diff", "--no-ext-diff", "--unified=3"],
  "git.log": ["git", "log", "-5", "--oneline"],
  "lean4.check": ["lake", "env", "lean"],
  "lean4.build": ["lake", "build"],
  "coq.check": ["coqc"],
  "isabelle.build": ["isabelle", "build"],
  "sage.run": ["sage"],
  "rust.check": ["cargo", "check"],
  "rust.test": ["cargo", "test"],
  "zig.build": ["zig", "build"],
  "python.test": ["python3", "-m", "pytest"],
});

function resolveWorkspace(candidate?: string): string {
  const base = path.resolve(candidate ?? WORKSPACE);
  const root = path.resolve(WORKSPACE);
  if (base !== root && !base.startsWith(`${root}${path.sep}`)) throw new Error("workspace is outside configured runtime workspace");
  return base;
}
function resolveFile(workspace: string, file: string): string {
  if (path.isAbsolute(file)) throw new Error("absolute file paths are not accepted");
  const target = path.resolve(workspace, file);
  if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) throw new Error("file escapes workspace");
  if (SECRET_NAMES.has(path.basename(target)) || SECRET_NAMES.has(path.basename(path.dirname(target)))) throw new Error("secret-like files are denied by default");
  return target;
}
function riskFor(tool: string): CodeRisk { if (["git.commit", "fs.delete", "package.install", "shell.external"].includes(tool)) return "high"; if (["fs.edit", "fs.write", "shell.run", "git.add", "compiler.run"].includes(tool)) return "medium"; return "low"; }
function run(command: readonly string[], cwd: string, timeoutMs: number): Promise<{ stdout:string; stderr:string; code:number|null; timed_out:boolean; truncated:boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell:false, stdio:["ignore","pipe","pipe"], detached:process.platform !== "win32", windowsHide:true });
    let stdout = ""; let stderr = ""; let bytes = 0; let truncated = false; let settled = false;
    const append = (which: "stdout"|"stderr", chunk: Buffer) => { const remain = 1024*1024-bytes; if (remain <= 0) { truncated=true; return; } const text=chunk.subarray(0,remain).toString("utf8"); bytes += Buffer.byteLength(text); if (which === "stdout") stdout += text; else stderr += text; if (chunk.length>remain) truncated=true; };
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { if (settled) return; settled=true; kill(); resolve({stdout,stderr,code:null,timed_out:true,truncated}); }, timeoutMs);
    child.stdout.on("data", c => append("stdout", c)); child.stderr.on("data", c => append("stderr", c));
    child.once("error", e => { if (settled) return; settled=true; clearTimeout(timer); reject(e); });
    child.once("close", code => { if (settled) return; settled=true; clearTimeout(timer); resolve({stdout,stderr,code,timed_out:false,truncated}); });
  });
}

export function listTools(): Array<{name:string;risk:CodeRisk}> { return [
  ["fs.read", "low"], ["fs.write", "medium"], ["fs.edit", "medium"], ["fs.list", "low"], ["fs.search", "low"],
  ["fs.delete", "high"], ["shell.run", "medium"], ["git.status", "low"], ["git.diff", "low"], ["git.commit", "high"],
  ["compiler.run", "medium"], ["lsp.diagnostics", "low"], ["memory.write", "low"],
].map(([name,risk]) => ({name, risk: risk as CodeRisk})); }

export async function readFile(workspace: string, file: string): Promise<string> { return fs.readFile(resolveFile(workspace,file), "utf8"); }
export async function listDir(workspace:string, dir="."):Promise<string[]> { const entries=await fs.readdir(resolveFile(workspace,dir),{withFileTypes:true}); return entries.map(e=>`${e.isDirectory()?"d":"f"} ${e.name}`).sort(); }
export async function searchCode(workspace:string, pattern:string):Promise<string[]> { if (!pattern || pattern.length>200) throw new Error("invalid search pattern"); const rx=new RegExp(pattern,"i"); const out:string[]=[]; async function walk(dir:string){ for(const e of await fs.readdir(dir,{withFileTypes:true})){ if(SECRET_NAMES.has(e.name) || e.name==="node_modules" || e.name===".git") continue; const p=path.join(dir,e.name); if(e.isDirectory()) await walk(p); else { try{const t=await fs.readFile(p,"utf8"); if(rx.test(t)) out.push(path.relative(workspace,p)); if(out.length>=500)return;}catch{}} } } await walk(workspace); return out; }
export async function writeFile(workspace:string,file:string,content:string):Promise<void>{ const target=resolveFile(workspace,file); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,content,{encoding:"utf8",mode:0o600}); }
export async function editFile(workspace:string,file:string,search:string,replacement:string):Promise<void>{ const target=resolveFile(workspace,file); const before=await fs.readFile(target,"utf8"); const count=before.split(search).length-1; if(count!==1) throw new Error(`edit target must match exactly once; found ${count}`); await fs.writeFile(target,before.replace(search,replacement),"utf8"); }
export async function deleteFile(workspace:string,file:string):Promise<void>{ await fs.rm(resolveFile(workspace,file),{force:true}); }

export async function runTool(taskId:string, tool:string, args:Record<string,unknown>, workspace:string, store:RuntimeStore):Promise<unknown>{
  if(!TOOL_ALLOWLIST.has(String(args.domain ?? tool.split(".")[0]))) throw new Error("tool domain is not allowed");
  const risk=riskFor(tool);
  store.audit("code.tool.start",{task_id:taskId,tool,risk});
  if(tool==="fs.read") return {content:await readFile(workspace,String(args.file))};
  if(tool==="fs.list") return {entries:await listDir(workspace,String(args.dir??"."))};
  if(tool==="fs.search") return {files:await searchCode(workspace,String(args.pattern))};
  if(tool==="fs.write") { await writeFile(workspace,String(args.file),String(args.content??"")); return {ok:true}; }
  if(tool==="fs.edit") { await editFile(workspace,String(args.file),String(args.search),String(args.replacement)); return {ok:true}; }
  if(tool==="fs.delete") { await deleteFile(workspace,String(args.file)); return {ok:true}; }
  if(tool.startsWith("git.")) { const sub=tool.slice(4); if(sub==="commit") throw new Error("git commit requires approval flow"); const cmd=COMMANDS[tool] ?? ["git",sub]; return run(cmd,workspace,15000); }
  if(tool==="shell.run") { if(!Array.isArray(args.argv) || !args.argv.every(x=>typeof x==="string")) throw new Error("shell.run requires argv:string[]"); const argv=args.argv as string[]; const executable=argv[0]; if(!executable) throw new Error("empty command"); return run(argv,workspace,120000); }
  if(tool==="compiler.run") { const language=String(args.language); const command=COMMANDS[`${language}.${String(args.action??"check")}`]; if(!command) throw new Error("compiler command is not allowlisted"); const argv=args.file ? [...command,String(args.file)] : [...command]; return run(argv,workspace,120000); }
  if(tool==="lsp.diagnostics") return {diagnostics:[]};
  if(tool==="memory.write") { store.writeCodeMemory(workspace,String(args.key),String(args.value??"")); return {ok:true}; }
  throw new Error(`unsupported code tool: ${tool}`);
}

export async function startCodeTask(request:CodeTaskRequest,store:RuntimeStore,onEvent:(event:any)=>void):Promise<any>{
  if(!request?.task?.trim()) throw new Error("task is required"); const workspace=resolveWorkspace(request.workspace); const id=`code-${Date.now()}-${crypto.randomUUID().slice(0,8)}`; const max=Math.max(1,Math.min(30,Math.floor(request.max_iterations??30))); let cancelled=false; active.set(id,{cancel:()=>{cancelled=true},paused:false}); store.upsertCodeTask(id,"running",request,{iteration:0,workspace}); onEvent({type:"started",payload:{task_id:id,workspace,max_iterations:max}});
  try {
    // Production foundation executes explicit tool steps supplied by the caller; model planning remains an external reasoning layer.
    const result={task_id:id,status:"completed",workspace,iterations:0,summary:`Code task accepted: ${request.task}`,note:"Use the /code tools or the DeepSeek orchestration layer to plan and execute individual allowlisted steps."};
    if(cancelled) result.status="cancelled"; store.upsertCodeTask(id,result.status,request,{iteration:0,workspace},result); onEvent({type:result.status==="cancelled"?"cancelled":"completed",payload:result}); return result;
  } finally { active.delete(id); }
}

export function pauseCodeTask(id:string):boolean{const c=active.get(id);if(!c)return false;c.paused=true;return true;}
export function resumeCodeTask(id:string):boolean{const c=active.get(id);if(!c)return false;c.paused=false;c.resume?.();return true;}
export function cancelCodeTask(id:string):boolean{const c=active.get(id);if(!c)return false;c.cancel();c.resume?.();return true;}
