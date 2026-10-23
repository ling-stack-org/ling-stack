import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { bundleFile, readExecutableBundle, resourcePath } from "./executable-bundle.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, resourceCheckpoint } from "./resource-workspace.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const selectionFile = join(repository, ".ling-stack/build/gstack-desktop-selection.json");

// Only the small build-owned pointer lives in the worktree. Hard-link publication
// is atomic and refuses an independently created selection; no existing pointer
// is ever replaced by this first-selection operation.
export async function publishFirstSelection(path, selection) {
  const bytes = `${JSON.stringify(selection, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new Error("gstack_selection_over_budget");
  const temporary = join(dirname(path), `.gstack-selection-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readGstackClosureFileRecord(path, { retain: true, maximumBytes: 16 * 1024 });
      if (!existing.bytes.equals(Buffer.from(bytes))) throw new Error("gstack_selection_existing_changed");
      return { reused: true };
    }
    return { reused: false };
  } finally { await rm(temporary); }
}

async function prepareSelectionDirectory() {
  let path = resolve(repository);
  if (await realpath(path) !== path) throw new Error("gstack_selection_repository_alias");
  for (const part of [".ling-stack", "build"]) {
    path = join(path, part);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("gstack_selection_directory_alias");
  }
}

export async function selectExecutableBundle({ root, expectedManifestChecksum }) {
  const lease = await requireResourceLease();
  root = resolve(root);
  if (root !== join(lease.root, "artifacts/native/executable-client/gstack")) throw new Error("gstack_selection_owned_bundle_required");
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedManifestChecksum ?? "")) throw new Error("gstack_selection_detached_manifest_required");
  if ((await bundleFile(root, "manifest.json")).checksum !== expectedManifestChecksum) throw new Error("gstack_selection_manifest_mismatch");
  const bundle = await readExecutableBundle(root);
  if (bundle.identity.target?.platform !== process.platform || bundle.identity.target?.arch !== process.arch) throw new Error("gstack_selection_target_mismatch");
  if (!Array.isArray(bundle.receipt.toolInputs) || !bundle.receipt.toolInputs.length) throw new Error("gstack_selection_tools_required");
  const seen = new Set();
  for (const previous of bundle.receipt.toolInputs) {
    resourcePath(previous.path);
    if (seen.has(previous.path) || !isDeepStrictEqual(previous, await bundleFile(repository, previous.path))) throw new Error("gstack_selection_build_inputs_changed");
    seen.add(previous.path);
  }
  if (bundle.identity.manifestChecksum !== expectedManifestChecksum) throw new Error("gstack_selection_manifest_mismatch");
  await resourceCheckpoint(lease.root);
  await prepareSelectionDirectory();
  const result = await publishFirstSelection(selectionFile, { root, identity: bundle.identity });
  return { ...result, selectionFile, identity: bundle.identity, releaseEligible: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, expectedManifestChecksum, ...extra] = process.argv.slice(2);
  if (!expectedManifestChecksum || extra.length) throw new Error("gstack_selection_arguments_invalid");
  console.log(JSON.stringify(await selectExecutableBundle({ root, expectedManifestChecksum })));
}
