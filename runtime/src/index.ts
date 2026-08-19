import { assertConfiguration, HOST, PORT } from "./config.js";
import { createRuntimeServer } from "./server.js";

assertConfiguration();
const server = createRuntimeServer();
server.listen(PORT, HOST, () => {
  console.log(`Better DeepSeek local runtime listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
