import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configurePackagedTestsavant } from "./testsavant-gs-client.mjs";

// Replaced only by the owned compiler after validating the component receipt.
const componentChecksum = "NO_PACKAGED_TESTSAVANT_COMPONENT";
const componentRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(componentRoot, "../..");
await configurePackagedTestsavant({ componentRoot, runtimeRoot,
  modelRoot: resolve(runtimeRoot, "models/testsavant-small"), componentChecksum });

export { isSidecarAvailable, scanWithSidecar, closeTestsavantSidecar } from "./testsavant-gs-client.mjs";
