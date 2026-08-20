import { assertConfiguration, HOST, PORT } from "./config.js";
import { createRuntimeServer } from "./server.js";
import { createCodeServer } from "./code-server.js";
import { createAgentControlServer } from "./agent-control-server.js";
import { assertBoundAddress, assertBearerToken } from "./security-policy.js";
import { installProcessGuards, log } from "./operational.js";

assertConfiguration();
assertBoundAddress(HOST);
assertBearerToken(String(process.env.BDS_RUNTIME_TOKEN ?? ""));
const server = createRuntimeServer();
const codeServer = createCodeServer();
const controlServer = createAgentControlServer();
const codePort = Number(process.env.BDS_CODE_PORT ?? PORT + 1);
const controlPort = Number(process.env.BDS_CONTROL_PORT ?? PORT + 2);
server.listen(PORT, HOST, () => log("info","runtime listening",{host:HOST,port:PORT}));
codeServer.listen(codePort, HOST, () => log("info","code agent listening",{host:HOST,port:codePort}));
controlServer.listen(controlPort, HOST, () => log("info","control plane listening",{host:HOST,port:controlPort}));

async function shutdown(signal: string): Promise<void> {
  log("info","shutdown requested",{signal});
  await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>codeServer.close(()=>r())),new Promise<void>(r=>controlServer.close(()=>r()))]);
  log("info","shutdown complete");
}
installProcessGuards(shutdown);
