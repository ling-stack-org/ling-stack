import { createServer } from "node:http";
import { basename } from "node:path";
import { createDaemonShutdownReporter } from "../../../../packages/core/dist/daemon-shutdown-observer.js";
import { createDaemonSignalShutdown } from "../../../../packages/daemon/dist/runtime/signal-shutdown.js";

// Isolated, no Store/provider/tools. Exercises production Desktop spawn stdio
// and real signals against an owned loopback service, not packaged acceptance.
const workspace = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
const reporter = createDaemonShutdownReporter({ fd: Number(process.env.LING_STACK_SHUTDOWN_OBSERVER_FD) });
delete process.env.LING_STACK_SHUTDOWN_OBSERVER_FD;
const server = createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ service: "ling-stack-daemon", defaultWorkspaceCwd: workspace }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(process.env.LING_STACK_PORT), "127.0.0.1", resolve);
});
let retained;
const stop = createDaemonSignalShutdown({
  onDraining: () => reporter.publish("draining"),
  stop: async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    if (basename(workspace) === "blocked") throw new Error("fixture_stop_unverified");
  },
  exit: code => process.exit(code),
  onBlocked: () => {
    retained ??= setInterval(() => undefined, 60000);
    reporter.publish("blocked");
  },
});
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
