import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./config.js";

export interface PermissionRule { tool:string; allow?:string[]; deny?:string[]; }
export interface AgentConfig { agents_root:string; workflows_root:string; skills_root:string; permissions:PermissionRule[]; mcp:Array<{name:string;url?:string;command?:string;args?:string[];enabled?:boolean;tools?:string[]}>; }
const ROOT=path.resolve(WORKSPACE);const PROJECT_CONFIG=path.join(ROOT,".better-deepseek.jsonc");
function stripJsonc(text:string){return text.replace(/\/\/.*$/gm,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/,\s*([}\]])/g,"$1");}
export async function loadAgentConfig():Promise<AgentConfig>{let raw="{}";try{raw=await fs.readFile(PROJECT_CONFIG,"utf8");}catch{}const parsed=JSON.parse(stripJsonc(raw));return {agents_root:path.join(ROOT,".better-deepseek","agents"),workflows_root:path.join(ROOT,".better-deepseek","workflows"),skills_root:path.join(ROOT,".better-deepseek","skills"),permissions:Array.isArray(parsed.permissions)?parsed.permissions:[],mcp:Array.isArray(parsed.mcp)?parsed.mcp:[]};}
function globMatch(pattern:string,value:string){const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*\*/g,"§§").replace(/\*/g,"[^/]*").replace(/§§/g,".*");return new RegExp(`^${escaped}$`).test(value);}
export function permitted(rules:PermissionRule[],tool:string,target=""){const rule=rules.find(r=>r.tool===tool);if(!rule)return true;if(rule.deny?.some(p=>globMatch(p,target)))return false;if(rule.allow?.length)return rule.allow.some(p=>globMatch(p,target));return true;}
