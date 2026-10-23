#!/usr/bin/env node

import { startDaemon } from "./index.js";
import { readPackagedRestrictedCommandConfig } from "./runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { readPackagedOfficeLocalNativeArtifact } from "./runtime/sandbox/packaged-office-native-bootstrap.js";
import { preparePackagedGstackStartup } from "./features/skills/packaged-startup.js";
import { readPackagedQaHarnessSelection } from "./runtime/packaged-qa-harness-bootstrap.js";
import { writeExecutionEngineHostAuthority } from "@ling-stack/core/execution-engine-host-authority";

const host = process.env.LING_STACK_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.LING_STACK_PORT ?? "17891", 10);

if (!Number.isFinite(port)) {
  console.error("LING_STACK_PORT must be a valid port number");
  process.exit(1);
}

const engineAuthorityChannel = process.env.LING_STACK_ENGINE_AUTHORITY_FD;
delete process.env.LING_STACK_ENGINE_AUTHORITY_FD;
// Validate selection before native/bootstrap side effects. Normal installs have no selection.
const qaHarness = readPackagedQaHarnessSelection(process.env);
const restrictedCommands = process.platform === "darwin"
  ? readPackagedRestrictedCommandConfig()
  : undefined;
const officeLocalNativeArtifact = readPackagedOfficeLocalNativeArtifact();
const initializeBundledSkills = await preparePackagedGstackStartup();
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
