import { describe, expect, it } from "vitest";
import { McpRegistry, loadAgents, loadSkills, loadWorkflows } from "../src/agent-orchestration-v2.js";
import { permitted } from "../src/agent-config.js";

describe("agent orchestration",()=>{
  it("enforces MCP URL and name policy",()=>{const r=new McpRegistry();expect(()=>r.add({name:"bad name",enabled:true,tools:[]})).toThrow();expect(()=>r.add({name:"exa",url:"https://mcp.example.test",enabled:true,tools:["search"]})).not.toThrow();expect(r.list()[0].name).toBe("exa");});
  it("applies deny over allow for workspace permissions",()=>{const rules=[{tool:"edit_file",allow:["src/**/*.lean"],deny:["**/.env"]}];expect(permitted(rules,"edit_file","src/Main.lean")).toBe(true);expect(permitted(rules,"edit_file","src/.env")).toBe(false);});
  it("loads file-backed agent/workflow/skill directories without requiring them to exist",async()=>{const [agents,skills,workflows]=await Promise.all([loadAgents(),loadSkills(),loadWorkflows()]);expect(Array.isArray(agents)).toBe(true);expect(Array.isArray(skills)).toBe(true);expect(Array.isArray(workflows)).toBe(true);});
});
