import { assertConfiguration, HOST, PORT } from "./config.js";
import { createRuntimeServer } from "./server.js";
import { createCodeServer } from "./code-server.js";

assertConfiguration();
const server = createRuntimeServer();
const codeServer = createCodeServer();
server.listen(PORT, HOST, () => {
  console.log(`Better DeepSeek local runtime listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});
codeServer.listen(Number(process.env.BDS_CODE_PORT ?? PORT + 1), HOST, () => {
  console.log(`Better DeepSeek Code Agent listening on http://${HOST}:${Number(process.env.BDS_CODE_PORT ?? PORT + 1)}`);
  console.log(`Code WebSocket endpoint: ws://${HOST}:${Number(process.env.BDS_CODE_PORT ?? PORT + 1)}/code/ws`);
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}; shutting down.`);
  let remaining = 2;
  const finish = () => { remaining -= 1; if (remaining === 0) process.exit(0); };
  server.close(finish);
  codeServer.close(finish);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
