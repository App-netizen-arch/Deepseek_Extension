import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateBearer } from "./auth.js";
import { HOST, PORT, TOKEN, LIMITS, WORKSPACE } from "./config.js";
import { RuntimeStore } from "./store.js";
import { runTool, listTools, type CodeTaskRequest } from "./code-production.js";
import { runAiCodeTask } from "./code-orchestrator.js";

const CODE_PORT = Number(process.env.BDS_CODE_PORT ?? PORT + 1);
const store = new RuntimeStore();
const activeTasks = new Set<Promise<unknown>>();

function json(res:http.ServerResponse,status:number,value:unknown){const body=JSON.stringify(value);res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(body);}
function body(req:http.IncomingMessage):Promise<string>{return new Promise((resolve,reject)=>{let total=0;const chunks:Buffer[]=[];req.on("data",(c:Buffer)=>{total+=c.length;if(total>LIMITS.httpBodyBytes){reject(new Error("request body too large"));req.destroy();return;}chunks.push(c)});req.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));req.on("error",reject);});}
function authed(req:http.IncomingMessage){return authenticateBearer(req.headers.authorization,TOKEN);}
function parseJson(text:string):any{try{return JSON.parse(text)}catch{throw new Error("invalid JSON");}}

export function createCodeServer(){
  const server=http.createServer(async(req,res)=>{
    if(req.url==="/code/health"){json(res,200,{ok:true,service:"better-deepseek-code-agent",host:HOST,port:CODE_PORT});return;}
    if(!authed(req)){json(res,401,{ok:false,error:"unauthorized"});return;}
    try{
      if(req.method==="GET"&&req.url==="/code/health"){json(res,200,{ok:true,workspace:WORKSPACE,tools:listTools()});return;}
      if(req.method==="GET"&&req.url==="/code/workspace"){json(res,200,{ok:true,workspace:WORKSPACE,memory:store.listCodeMemory(WORKSPACE)});return;}
      if(req.method==="POST"&&req.url==="/code/workspace/index"){const result=await runTool("index","fs.search",{pattern:typeof (req.headers["x-index-pattern"])==="string"?req.headers["x-index-pattern"]:"."},WORKSPACE,store).catch(error=>({error:error instanceof Error?error.message:String(error)}));json(res,200,{ok:true,result});return;}
      if(req.method==="GET"&&req.url?.match(/^\/code\/tasks\/[^/]+$/)){const id=decodeURIComponent(req.url.slice("/code/tasks/".length));const task=store.getCodeTask(id);json(res,task?200:404,task?{ok:true,task}:{ok:false,error:"task_not_found"});return;}
      if(req.method==="POST"&&req.url==="/code/tasks"){
        if(activeTasks.size>=LIMITS.maxConcurrentJobs){json(res,429,{ok:false,error:"maximum concurrent background jobs reached"});return;}
        const request=parseJson(await body(req)) as CodeTaskRequest;
        const task=runAiCodeTask(request,store,event=>broadcast(event));
        activeTasks.add(task);task.finally(()=>activeTasks.delete(task));
        const taskId=`code-${Date.now()}-${request.task.slice(0,12).replace(/[^A-Za-z0-9_-]/g,"-")}`;
        json(res,202,{ok:true,task_id:taskId,status:"queued",note:"task state is persisted in SQLite; the emitted task id is authoritative from the runtime event stream"});
        return;
      }
      if(req.method==="POST"&&req.url?.match(/^\/code\/tools\/[^/]+$/)){const tool=decodeURIComponent(req.url.slice("/code/tools/".length));const args=parseJson(await body(req));const result=await runTool(`manual-${Date.now()}`,tool,args,WORKSPACE,store);json(res,200,{ok:true,result});return;}
      if(req.method==="GET"&&req.url==="/code/memory"){json(res,200,{ok:true,memory:store.listCodeMemory(WORKSPACE)});return;}
      json(res,404,{ok:false,error:"not_found"});
    }catch(error){json(res,400,{ok:false,error:error instanceof Error?error.message:String(error)});}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:LIMITS.wsMessageBytes});
  const clients=new Set<WebSocket>();
  function broadcast(event:unknown){const text=JSON.stringify(event);for(const c of clients)if(c.readyState===1)c.send(text);}
  wss.on("connection",socket=>{clients.add(socket);socket.on("message",async data=>{try{const message=JSON.parse(data.toString()) as {type?:string;token?:string;payload?:any};if(message.type==="auth"){if(message.token!==TOKEN){socket.close(1008,"invalid token");return;}socket.send(JSON.stringify({type:"code/status",payload:{ok:true,workspace:WORKSPACE,tools:listTools()}}));return;}if(message.type==="code/task"){const p=message.payload as CodeTaskRequest;const task=runAiCodeTask(p,store,event=>socket.send(JSON.stringify({type:"code/event",payload:event})));activeTasks.add(task);task.finally(()=>activeTasks.delete(task));return;}if(message.type==="code/tool"){const p=message.payload as {tool:string;args:Record<string,unknown>};const result=await runTool(`ws-${Date.now()}`,p.tool,p.args,WORKSPACE,store);socket.send(JSON.stringify({type:"code/tool_result",payload:{tool:p.tool,result}}));return;}socket.send(JSON.stringify({type:"code/error",payload:{message:"unsupported message"}}));}catch(error){socket.send(JSON.stringify({type:"code/error",payload:{message:error instanceof Error?error.message:String(error)}}));}});socket.on("close",()=>clients.delete(socket));});
  server.on("upgrade",(req,socket,head)=>{const url=new URL(req.url??"/",`http://${HOST}`);if(url.pathname!=="/code/ws"){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));});
  server.on("close",()=>{wss.close();for(const c of clients)c.close();store.close();});
  return server;
}
