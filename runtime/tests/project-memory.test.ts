import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { ProjectMemoryStore, memoryContext } from "../src/project-memory.js";

describe("project memory",()=>{
  let dir:string; let dbPath:string; let store:ProjectMemoryStore;
  beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"bds-memory-"));dbPath=path.join(dir,"memory.db");process.env.BDS_MEMORY_KEY=Buffer.alloc(32,7).toString("base64");process.env.BDS_WORKSPACE=dir;process.env.BDS_DB_PATH=dbPath;store=new ProjectMemoryStore();});
  afterEach(()=>{store.close();delete process.env.BDS_MEMORY_KEY;delete process.env.BDS_DB_PATH;});
  it("isolates projects and returns bounded retrieval",()=>{const a=store.createProject("a",dir);const b=store.createProject("b",dir);store.write(a.id,{module:"code",type:"fact",key:"one",value:"alpha"});store.write(b.id,{module:"code",type:"fact",key:"one",value:"beta"});expect(store.search(a.id,"alpha").map(x=>x.value)).toEqual(["alpha"]);expect(store.search(a.id,"beta")).toEqual([]);expect(store.list(a.id).length).toBe(1);});
  it("stores ciphertext rather than plaintext and builds delimited context",()=>{const p=store.createProject("p",dir);store.write(p.id,{module:"math",type:"mathir",key:"eq",value:"x^2+y^2=z^2",source:"paper.pdf:2"});const raw=new Database(dbPath).prepare("SELECT value_ciphertext FROM memories").get() as {value_ciphertext:string};expect(raw.value_ciphertext).not.toContain("x^2+y^2=z^2");expect(memoryContext(store.list(p.id))).toContain("[MEMORY]");});
});
