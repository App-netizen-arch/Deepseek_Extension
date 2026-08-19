import { assertConfiguration, HOST, PORT } from "./config.js";
import { createRuntimeServer } from "./server.js";
import { createCodeServer } from "./code-server.js";
import { createAgentControlServer } from "./agent-control-server.js";

assertConfiguration();
const server = createRuntimeServer();
const codeServer = createCodeServer();
const controlServer = createAgentControlServer();
const codePort = Number(process.env.BDS_CODE_PORT ?? PORT + 1);
const controlPort = Number(process.env.BDS_CONTROL_PORT ?? PORT + 2);
server.listen(PORT, HOST, () => {
  console.log(`Better DeepSeek local runtime listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});
codeServer.listen(codePort, HOST, () => {
  console.log(`Better DeepSeek Code Agent listening on http://${HOST}:${codePort}`);
  console.log(`Code WebSocket endpoint: ws://${HOST}:${codePort}/code/ws`);
});
controlServer.listen(controlPort, HOST, () => {
  console.log(`Better DeepSeek Agent Control listening on http://${HOST}:${controlPort}`);
  console.log(`Control WebSocket endpoint: ws://${HOST}:${controlPort}/control/ws`);
});
const shutdown = (signal: string) => {
  console.log(`Received ${signal}; shutting down.`);
  let remaining = 3;
  const finish = () => { remaining -= 1; if (remaining === 0) process.exit(0); };
  server.close(finish);
  codeServer.close(finish);
  controlServer.close(finish);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
