import { registerHooks } from "node:module";

// Keep the actual CLI entry/signal handlers. Only its unrelated server startup
// is replaced; no network, workspace, credential or model operation is made.
const indexUrl = new URL("../../dist/index.js", import.meta.url).href;
const outcome = process.argv[2];
if (!["blocked", "closed", "late-drain"].includes(outcome)) throw new Error("invalid_signal_shutdown_fixture");
registerHooks({ load(url, context, nextLoad) {
  if (url !== indexUrl) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: `
    export async function startDaemon(config) {
      const owned = setInterval(() => undefined, 60000);
      return { config, server: { address: () => ({ port: 0 }) }, async stop(options) {
        console.log('owned-stop-called');
        if (${JSON.stringify(outcome)} === 'blocked') throw new Error('owned-stop-proof-unverified');
        if (${JSON.stringify(outcome)} === 'late-drain') {
          if (options?.waitForOwnedDrain !== true) {
            const error = new Error('Media local executions have not drained.');
            error.name = 'MediaLocalExecutionDrainTimeoutError';
            error.code = 'media_local_drain_timeout';
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          console.log('owned-actual-drain-completed');
        }
        clearInterval(owned);
      } };
    }
  ` };
} });
await import("../../dist/cli.js");
