import {describe,expect,it} from "vitest";
import {McpRegistry,loadAgents,loadSkills,loadWorkflows} from "../src/agent-orchestration-v2.js";
import {permitted} from "../src/agent-config.js";

describe("agent orchestration",()=>{
  it("validates MCP registry",()=>{
    const r=new McpRegistry();
    expect(()=>r.add({name:"bad name",enabled:true,tools:[]})).toThrow();
    expect(r.add({name:"exa",url:"https://mcp.example.test",enabled:true,tools:["search"]}).name).toBe("exa");
  });

  it("applies deny over allow",()=>{
    const rules=[{tool:"edit_file",allow:["src/**/*.lean"],deny:["**/.env"]}];
    expect(permitted(rules,"edit_file","src/Main.lean")).toBe(true);
    expect(permitted(rules,"edit_file","src/deep/Main.lean")).toBe(true);
    expect(permitted(rules,"edit_file","src/.env")).toBe(false);
    expect(permitted(rules,"edit_file",".env")).toBe(false);
    expect(permitted(rules,"edit_file","src/deep/.env")).toBe(false);
  });

  it("loads file-backed resources",async()=>{
    const [a,s,w]=await Promise.all([loadAgents(),loadSkills(),loadWorkflows()]);
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(s)).toBe(true);
    expect(Array.isArray(w)).toBe(true);
  });
});
