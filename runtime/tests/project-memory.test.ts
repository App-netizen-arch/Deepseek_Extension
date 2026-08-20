import {describe,expect,it,beforeEach,afterEach} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {ProjectMemoryStore,memoryContext} from "../src/project-memory.js";

describe("project memory",()=>{
  let dir:string;
  let dbPath:string;
  let store:ProjectMemoryStore;

  beforeEach(()=>{
    dir=fs.mkdtempSync(path.join(os.tmpdir(),"bds-memory-"));
    dbPath=path.join(dir,"memory.db");
    process.env.BDS_MEMORY_KEY=Buffer.alloc(32,7).toString("base64");
    store=new ProjectMemoryStore(dbPath);
  });

  afterEach(()=>{
    store.close();
    delete process.env.BDS_MEMORY_KEY;
  });

  it("isolates projects",()=>{
    const a=store.createProject("a",dir),b=store.createProject("b",dir);
    store.write(a.id,{module:"code",type:"fact",key:"one",value:"alpha"});
    store.write(b.id,{module:"code",type:"fact",key:"one",value:"beta"});
    expect(store.search(a.id,"alpha").map(x=>x.value)).toEqual(["alpha"]);
    expect(store.search(a.id,"beta")).toEqual([]);
  });

  it("encrypts stored values and owns its audit schema",()=>{
    const p=store.createProject("p",dir);
    store.write(p.id,{module:"math",type:"mathir",key:"eq",value:"x^2+y^2=z^2",source:"paper.pdf:2"});
    const db=new Database(dbPath);
    try{
      const raw=db.prepare("SELECT value_ciphertext FROM memories").get() as {value_ciphertext:string};
      expect(raw.value_ciphertext).not.toContain("x^2+y^2=z^2");
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({count:expect.any(Number)});
    }finally{db.close();}
    expect(memoryContext(store.list(p.id))).toContain("[MEMORY]");
  });

  it("can open a second isolated store on a separate database",()=>{
    const secondPath=path.join(dir,"second.db");
    const second=new ProjectMemoryStore(secondPath);
    try{
      const p=second.createProject("second",dir);
      second.write(p.id,{module:"shared",type:"fact",key:"isolated",value:"yes"});
      expect(second.list(p.id)).toHaveLength(1);
      expect(store.listProjects()).toHaveLength(0);
    }finally{second.close();}
  });
});
