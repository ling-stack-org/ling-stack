#!/usr/bin/env node

import { startDaemon } from "./index.js";
import { readPackagedRestrictedCommandConfig } from "./runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { readPackagedOfficeLocalNativeArtifact } from "./runtime/sandbox/packaged-office-native-bootstrap.js";
import { preparePackagedGstackStartup } from "./features/skills/packaged-startup.js";
import { readPackagedQaHarnessSelection } from "./runtime/packaged-qa-harness-bootstrap.js";
import { createDaemonSignalShutdown } from "./runtime/signal-shutdown.js";
import { writeExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";
import { writeDaemonResourceBootstrap } from "@ling-stack/core/daemon-resource-bootstrap";
import { createDaemonShutdownReporter } from "@ling-stack/core/daemon-shutdown-observer";

const host = process.env.LING_STACK_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.LING_STACK_PORT ?? "17891", 10);

if (!Number.isFinite(port)) {
  console.error("LING_STACK_PORT must be a valid port number");
  process.exit(1);
}

const engineAuthorityChannel = process.env.LING_STACK_ENGINE_AUTHORITY_FD;
delete process.env.LING_STACK_ENGINE_AUTHORITY_FD;
const resourceBootstrapChannel = process.env.LING_STACK_RESOURCE_BOOTSTRAP_FD;
delete process.env.LING_STACK_RESOURCE_BOOTSTRAP_FD;
const shutdownObserverChannel = process.env.LING_STACK_SHUTDOWN_OBSERVER_FD;
delete process.env.LING_STACK_SHUTDOWN_OBSERVER_FD;
if (shutdownObserverChannel !== undefined && shutdownObserverChannel !== "5") {
  throw new Error("daemon_shutdown_observer_invalid");
}
const shutdownReporter = shutdownObserverChannel === "5" ? createDaemonShutdownReporter({ fd: 5 }) : undefined;
if (resourceBootstrapChannel !== undefined
  && (resourceBootstrapChannel !== "4" || process.env.LING_STACK_PACKAGED_DESKTOP !== "1")) {
  throw new Error("daemon_resource_bootstrap_invalid");
}
// Validate selection before native/bootstrap side effects. Normal installs have no selection.
const qaHarness = readPackagedQaHarnessSelection(process.env);
const restrictedCommands = process.platform === "darwin"
  ? readPackagedRestrictedCommandConfig()
  : undefined;
const officeLocalNativeArtifact = readPackagedOfficeLocalNativeArtifact();
const initializeBundledSkills = await preparePackagedGstackStartup();
if (resourceBootstrapChannel === "4") writeDaemonResourceBootstrap({ fd: 4 });
const daemon = await startDaemon({
  host,
  port,
  ...(qaHarness ? { harness: qaHarness } : {}),
  ...(restrictedCommands ? { sandbox: { restrictedCommands } } : {}),
}, { ...(officeLocalNativeArtifact ? { officeLocalNativeArtifact } : {}),
  ...(initializeBundledSkills ? { initializeBundledSkills } : {}) });
const address = daemon.server.address();
const managementHost = host === "::1" ? "[::1]" : host === "localhost" ? "localhost" : "127.0.0.1";
if (engineAuthorityChannel === "3" && ["127.0.0.1", "localhost", "::1"].includes(host) && address && typeof address !== "string") {
  try {
    writeExecutionEngineHostAuthority({ fd: 3, baseUrl: `http://${managementHost}:${address.port}`, credentials: daemon.engineManagement });
  } catch {
    console.error("engine_host_authority_unavailable");
  }
}
console.log(`Ling Stack daemon listening on http://${daemon.config.host}:${daemon.config.port}`);

// Keep this Host alive on an unverified stop. Letting its rejection become an
// unhandled crash would trigger Desktop's automatic restart without a stopped
// receipt. This is an explicit blocked lifecycle, not evidence of active work.
let blockedShutdownKeepAlive: ReturnType<typeof setInterval> | undefined;
const stop = createDaemonSignalShutdown({
  onDraining: () => { shutdownReporter?.publish("draining"); },
  // A finite embedding observer may time out while real cleanup continues.
  // Signals await that original cleanup instead of permanently caching timeout.
  stop: () => daemon.stop({ waitForOwnedDrain: true }),
  exit: code => { process.exit(code); },
  onBlocked: () => {
    blockedShutdownKeepAlive ??= setInterval(() => undefined, 60_000);
    // Retention is installed before observer I/O, including a closed Main pipe.
    try { shutdownReporter?.publish("blocked"); } catch { /* Host still retained. */ }
    console.error("daemon_shutdown_blocked: stop proof unavailable; Host retained, automatic restart withheld");
  },
});

process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
