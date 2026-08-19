const base="http://127.0.0.1:3039";
const token=process.env.BDS_RUNTIME_TOKEN;
if(!token)throw new Error("BDS_RUNTIME_TOKEN is required");
const unauth=await fetch(`${base}/memory/projects`);if(unauth.status!==401)throw new Error(`expected 401, got ${unauth.status}`);
const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
const health=await fetch(`${base}/control/health`);if(!health.ok)throw new Error("control health failed");
const projects=await fetch(`${base}/memory/projects`,{headers});if(!projects.ok)throw new Error(`authenticated memory access failed: ${projects.status}`);
const traversal=await fetch(`${base}/memory/projects`,{method:"POST",headers,body:JSON.stringify({name:"security-test",workspace_path:"../../etc"})});if(traversal.status<400)throw new Error("workspace traversal was accepted");
console.log("Live security smoke test passed.");
