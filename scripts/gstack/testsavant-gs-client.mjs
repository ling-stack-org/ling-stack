import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTestsavantClient } from "./testsavant-client.mjs";
import { ensureTestsavantModelCache, testsavantModelAcquisition } from "./testsavant-model-cache.mjs";

let client, configuration, preparation, modelStatus = "bundled", modelFailure, generation = 0;

// Called by the owned host after component admission, never by an untrusted
// page/request. Missing admission cannot fall back to system Node or downloads.
export function configureTestsavantSidecar(options) {
  if (client) throw new Error("testsavant_already_running");
  configuration = { ...options };
  preparation = undefined; modelFailure = undefined; generation++;
  modelStatus = options.modelMode === "download-required" ? "not-downloaded" : "bundled";
}

export async function admitTestsavantComponent({ runtimeRoot, componentRoot, modelRoot, componentChecksum }) {
  for (const path of [runtimeRoot, componentRoot, modelRoot]) {
    if (typeof path !== "string" || resolve(path) !== path) throw new Error("testsavant_host_path_invalid");
  }
  const receiptPath = join(componentRoot, "testsavant-component.json");
  const { verifyTestsavantExecutable } = await import("./testsavant-client.mjs");
  // The outer authenticated resource manifest supplies the expected receipt.
  await verifyTestsavantExecutable(receiptPath, componentChecksum, 128 * 1024);
  const bytes = await readFile(receiptPath);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== componentChecksum) throw new Error("testsavant_component_changed");
  const receipt = JSON.parse(bytes);
  if (receipt.schemaVersion !== 1 || receipt.scope !== "managed-testsavant-component" ||
    receipt.artifacts?.[0]?.path !== "testsavant-sidecar.mjs") throw new Error("testsavant_component_invalid");
  const entry = join(componentRoot, "testsavant-sidecar.mjs");
  await verifyTestsavantExecutable(entry, receipt.artifacts[0].checksum);
  const modelMode = receipt.modelAcquisition?.mode;
  if (modelMode !== undefined && (modelMode !== "download-required" ||
    JSON.stringify(receipt.modelAcquisition) !== JSON.stringify(testsavantModelAcquisition()))) throw new Error("testsavant_model_acquisition_invalid");
  return { runtimeRoot, modelRoot, entry, nodeChecksum: receipt.node.checksum, entryChecksum: receipt.artifacts[0].checksum,
    ...(modelMode ? { modelMode } : {}) };
}

export async function configurePackagedTestsavant(options) {
  const admitted = await admitTestsavantComponent(options);
  if (admitted.modelMode === "download-required") {
    const receipt = await readFile(join(options.runtimeRoot, "testsavant-model-acquisition.json"));
    if (JSON.stringify(JSON.parse(receipt)) !== JSON.stringify(testsavantModelAcquisition())) throw new Error("testsavant_model_acquisition_invalid");
    admitted.stateRoot = process.env.GSTACK_STATE_ROOT;
  }
  configureTestsavantSidecar(admitted);
}

export function isSidecarAvailable() {
  return configuration ? { available: true, modelStatus } : { available: false, reason: "managed-component-not-admitted" };
}

export async function scanWithSidecar(text, options) {
  if (!configuration) throw new Error("testsavant_not_admitted");
  if (configuration.modelMode === "download-required" && modelStatus !== "ready") {
    if (!preparation) {
      modelStatus = "downloading";
      const currentGeneration = generation, currentConfiguration = configuration;
      preparation = (configuration.prepareModel ?? ensureTestsavantModelCache)(configuration.stateRoot).then(modelRoot => {
        if (generation !== currentGeneration) return;
        currentConfiguration.modelRoot = modelRoot; modelStatus = "ready";
      }, error => {
        if (generation !== currentGeneration) return;
        modelFailure = String(error?.message ?? "download_failed").slice(0, 300); modelStatus = "failed";
      });
    }
    if (modelStatus === "failed") {
      preparation = undefined;
      throw new Error(`testsavant_model_failed: ${modelFailure}; the next explicit scan retries the fixed official download`);
    }
    throw new Error("testsavant_model_downloading: preparing the pinned model in the application cache; scan again after download and verification complete");
  }
  client ??= createTestsavantClient(configuration);
  return client.scan(text, options);
}

export async function closeTestsavantSidecar() {
  generation++;
  await client?.close(); client = undefined; configuration = undefined; preparation = undefined; modelStatus = "bundled"; modelFailure = undefined;
}
