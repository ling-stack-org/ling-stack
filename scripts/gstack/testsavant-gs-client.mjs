import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTestsavantClient } from "./testsavant-client.mjs";

let client, configuration;

// Called by the owned host after component admission, never by an untrusted
// page/request. Missing admission cannot fall back to system Node or downloads.
export function configureTestsavantSidecar(options) {
  if (client) throw new Error("testsavant_already_running");
  configuration = { ...options };
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
  return { runtimeRoot, modelRoot, entry, nodeChecksum: receipt.node.checksum, entryChecksum: receipt.artifacts[0].checksum };
}

export async function configurePackagedTestsavant(options) {
  configureTestsavantSidecar(await admitTestsavantComponent(options));
}

export function isSidecarAvailable() {
  return configuration ? { available: true } : { available: false, reason: "managed-component-not-admitted" };
}

export async function scanWithSidecar(text, options) {
  if (!configuration) throw new Error("testsavant_not_admitted");
  client ??= createTestsavantClient(configuration);
  return client.scan(text, options);
}

export async function closeTestsavantSidecar() {
  await client?.close(); client = undefined; configuration = undefined;
}
