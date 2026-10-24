import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyBundledSkillSource } from "../../packages/core/src/bundled-skill-source.ts";
import { verifyPackagedBrowser } from "../../packages/core/src/bundled-skill-browser.ts";
import { testsavantModelAcquisition } from "./testsavant-model-cache.mjs";

export const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function resourcePath(path) {
  if (typeof path !== "string" || !path || /[\\:\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("gstack_executable_path_invalid");
  return path;
}
export async function bundleFile(root, path) {
  const full = join(root, resourcePath(path)), before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(full) !== full) throw new Error(`gstack_executable_file_invalid:${path}`);
  const hash = createHash("sha256"); let sizeBytes = 0;
  for await (const bytes of createReadStream(full)) { hash.update(bytes); sizeBytes += bytes.length; }
  const after = await lstat(full);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || before.size !== sizeBytes || after.size !== sizeBytes) throw new Error("gstack_executable_input_changed");
  return { path, checksum: `sha256:${hash.digest("hex")}`, sizeBytes };
}
export async function bundleInventory(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await bundleInventory(root, path));
    else if (entry.isFile()) files.push(await bundleFile(root, path));
    else throw new Error(`gstack_executable_link_or_special_file:${path}`);
    if (files.length > 100_000) throw new Error("gstack_executable_inventory_over_budget");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export async function readExecutableBundle(root, expectedIdentity) {
  root = resolve(root);
  if (await realpath(root) !== root) throw new Error("gstack_executable_root_alias");
  if ((await lstat(join(root, "manifest.json"))).size > 16 * 1024 ** 2) throw new Error("gstack_executable_manifest_over_budget");
  const bytes = await readFile(join(root, "manifest.json"));
  if (bytes.length > 16 * 1024 ** 2) throw new Error("gstack_executable_manifest_over_budget");
  const manifest = JSON.parse(bytes);
  const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url)));
  const identity = { manifestChecksum: digest(bytes), upstreamRevision: lock.revision,
    adaptationRevision: manifest.adaptationRevision, target: manifest.target, skillIds: lock.skillIds };
  if (expectedIdentity && !isDeepStrictEqual(identity, expectedIdentity)) throw new Error("gstack_executable_identity_changed");
  const source = await verifyBundledSkillSource({ rootPath: root, expectedManifestChecksum: identity.manifestChecksum,
    expectedUpstreamRevision: lock.revision, expectedAdaptationRevision: identity.adaptationRevision,
    expectedTarget: identity.target, expectedSkillIds: lock.skillIds, requireExecutable: true });
  const receipt = JSON.parse(await source.readResource("executable-build.json"));
  if (receipt.scope !== "isolated-local-client" || receipt.releaseEligible !== false
    || receipt.upstreamRevision !== lock.revision || !["package-relative-only", "download-required"].includes(receipt.browser?.activation)) {
    throw new Error("gstack_executable_receipt_invalid");
  }
  if (receipt.modelAcquisition) {
    const acquisition = JSON.parse(await source.readResource("runtime/testsavant-model-acquisition.json"));
    if (!isDeepStrictEqual(receipt.modelAcquisition, testsavantModelAcquisition()) ||
      !isDeepStrictEqual(acquisition, receipt.modelAcquisition) || manifest.files.some(file => file.path.startsWith("runtime/models/"))) {
      throw new Error("gstack_executable_model_acquisition_invalid");
    }
  }
  const browser = verifyPackagedBrowser(resolve(root, "../gstack-browser"), receipt.browser, identity.target);
  return Object.freeze({ root, identity: Object.freeze(identity), source, receipt, browser });
}
