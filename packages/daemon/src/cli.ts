#!/usr/bin/env node

import { startDaemon } from "./index.js";

const host = process.env.LING_STACK_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.LING_STACK_PORT ?? "17891", 10);

if (!Number.isFinite(port)) {
  console.error("LING_STACK_PORT must be a valid port number");
  process.exit(1);
}

const daemon = await startDaemon({ host, port });
console.log(`Ling Stack daemon listening on http://${daemon.config.host}:${daemon.config.port}`);

const stop = async (): Promise<void> => {
  await daemon.stop();
  process.exit(0);
};

process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
