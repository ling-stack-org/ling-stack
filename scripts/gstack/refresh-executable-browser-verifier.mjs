import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { bundleFile, bundleInventory, digest, readExecutableBundle } from "./executable-bundle.mjs";
import { requireResourceLease } from "./resource-workspace.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const ownPath = "scripts/gstack/refresh-executable-browser-verifier.mjs";
const verifier = "packages/core/src/bundled-skill-browser.ts";
const canonical = rows => JSON.stringify(rows.map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes }))
  .sort((a, b) => a.path.localeCompare(b.path, "en")));

export async function verifyRefreshStage(stageRoot, receipt, previousBuild) {
  if (await realpath(stageRoot) !== stageRoot) throw new Error("gstack_refresh_stage_alias");
  const stageBytes = await readFile(join(stageRoot, "resource-stage.json"));
  if (digest(stageBytes) !== receipt.retainedStageChecksum) throw new Error("gstack_refresh_stage_changed");
  const stage = JSON.parse(stageBytes), inventoryBytes = await readFile(join(stageRoot, "resource-inventory.json"));
  if (digest(inventoryBytes) !== stage.inventoryChecksum) throw new Error("gstack_refresh_stage_changed");
  const inventory = JSON.parse(inventoryBytes).files;
  const expected = [...inventory, ...await Promise.all(["resource-stage.json", "resource-inventory.json"].map(path => bundleFile(stageRoot, path)))];
  if (canonical(await bundleInventory(stageRoot)) !== canonical(expected)) throw new Error("gstack_refresh_stage_changed");
  const compiler = inventory.find(file => file.path === "runtime/tools/bun");
  if (!compiler || compiler.checksum !== previousBuild.compiler.checksum || compiler.sizeBytes !== previousBuild.compiler.sizeBytes) {
    throw new Error("gstack_refresh_compiler_changed");
  }
  return { stageChecksum: digest(stageBytes), compiler };
}

export function assertRefreshBuildDelta(previous, current, verifierInput) {
  const expectedInputs = previous.inputs.map(input => input.path === verifier ? verifierInput : input);
  for (const key of ["schemaVersion", "deliveryStage", "compiledArtifactBinding", "upstreamRevision", "sourceManifestChecksum",
    "compiler", "target", "toolInputs", "recipe", "launchPins", "serverReceiptChecksum", "launchPolicy"]) {
    if (!isDeepStrictEqual(previous[key], current[key])) throw new Error(`gstack_refresh_build_delta_invalid:${key}`);
  }
  if (!isDeepStrictEqual(expectedInputs, current.inputs) || !previous.inputs.some(input => input.path === verifier)) {
    throw new Error("gstack_refresh_build_delta_invalid:inputs");
  }
}

/** Replace only the affected CLI/receipts, with bounded rollback, never a full tree. */
export async function refreshExecutableBrowserVerifier({ root, stageRoot, expectedManifestChecksum }) {
  const lease = await requireResourceLease();
  root = resolve(root); stageRoot = resolve(stageRoot);
  if (root !== join(lease.root, "artifacts/native/executable-client/gstack")) throw new Error("gstack_refresh_owned_candidate_required");
  const selectionPath = join(repository, ".ling-stack/build/gstack-desktop-selection.json");
  const selectionBytes = await readFile(selectionPath), selection = JSON.parse(selectionBytes);
  if (selection.root !== root || selection.identity.manifestChecksum !== expectedManifestChecksum) throw new Error("gstack_refresh_selection_changed");
  const before = await readExecutableBundle(root, selection.identity);
  const receipt = before.receipt, nextInputs = [];
  let changed = false;
  for (const previous of receipt.toolInputs) {
    const current = await bundleFile(repository, previous.path);
    if (!isDeepStrictEqual(previous, current)) {
      if (previous.path !== verifier) throw new Error("gstack_refresh_unrelated_input_changed");
      changed = true;
    }
    nextInputs.push(current);
  }
  const replayOnly = !changed && receipt.refresh?.recipe === "browser-verifier-only-cli-recompile-no-full-copy";
  if (!changed && !replayOnly || changed && receipt.refresh) throw new Error("gstack_refresh_exact_verifier_delta_required");
  const ownInput = await bundleFile(repository, ownPath);
  const previousBuild = JSON.parse(await readFile(join(root, "runtime/browse/dist/browse.build-provenance.json")));
  const stageAdmission = await verifyRefreshStage(stageRoot, receipt, previousBuild);
  const work = await mkdtemp(join(lease.scratchPath, "tmp", "gstack-cli-refresh-"));
  const selected = `${selectionPath}.${lease.token}.tmp`;
  const compiled = join(work, "compiled"), next = join(work, "next"), backup = join(work, "backup");
  const replacements = ["runtime/browse/dist/browse", "runtime/browse/dist/browse.build-provenance.json", "executable-build.json", "manifest.json"];
  let mutated = false, accepted = false;
  try {
    for (const path of [compiled, next, backup]) await mkdir(path);
    for (const path of ["browse/dist/server-node.mjs", "browse/dist/bun-polyfill.cjs", "browse/dist/node-server-build-provenance.json",
      "browse/dist/testsavant-component.json", "browse/dist/testsavant-sidecar.mjs", "browser-selection.json", "tools/node"]) {
      await mkdir(dirname(join(compiled, path)), { recursive: true });
      await copyFile(join(root, "runtime", path), join(compiled, path));
    }
    const runtime = join(stageRoot, "runtime");
    execFileSync(join(runtime, "tools/bun"), ["--no-env-file", "--no-install", join(repository, "scripts/gstack/build-bun-native-resource.mjs"),
      "packaged-browse", runtime, compiled], { cwd: runtime, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      timeout: 120000, maxBuffer: 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] });
    const currentBuild = JSON.parse(await readFile(join(compiled, "browse/dist/browse.build-provenance.json")));
    assertRefreshBuildDelta(previousBuild, currentBuild, await bundleFile(repository, verifier));
    if (replayOnly) {
      if (!isDeepStrictEqual(previousBuild.artifact, currentBuild.artifact)) throw new Error("gstack_refresh_replay_artifact_changed");
      if (!isDeepStrictEqual(ownInput, await bundleFile(repository, ownPath))) throw new Error("gstack_refresh_inputs_changed");
      const verified = await readExecutableBundle(root, before.identity);
      if (!(await readFile(selectionPath)).equals(selectionBytes)) throw new Error("gstack_refresh_selection_changed");
      return { identity: verified.identity, scope: "independently-pinned-stage-recompile-qualification",
        fullTreeCopied: false, changedPaths: [], stageAdmission, toolInput: ownInput, artifact: currentBuild.artifact, releaseEligible: false };
    }
    for (const path of replacements.slice(0, 2)) {
      await mkdir(dirname(join(next, path)), { recursive: true });
      await copyFile(join(compiled, path.slice("runtime/".length)), join(next, path));
    }
    const adaptationRevision = `ling-${digest(Buffer.from(canonical([...nextInputs, ownInput]))).slice(7)}`;
    const nextReceipt = { ...receipt, adaptationRevision, toolInputs: nextInputs,
      refresh: { recipe: "browser-verifier-only-cli-recompile-no-full-copy", previousManifestChecksum: expectedManifestChecksum, toolInput: ownInput } };
    await writeFile(join(next, "executable-build.json"), `${JSON.stringify(nextReceipt, null, 2)}\n`);
    const changedFiles = await Promise.all(replacements.slice(0, 3).map(path => bundleFile(next, path)));
    const manifest = { ...before.source.manifest, adaptationRevision, files: before.source.manifest.files.map(file =>
      changedFiles.find(replacement => replacement.path === file.path) ?? file) };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(next, "manifest.json"), manifestBytes);
    for (const previous of [...nextInputs, ownInput]) {
      if (!isDeepStrictEqual(previous, await bundleFile(repository, previous.path))) throw new Error("gstack_refresh_inputs_changed");
    }
    if (!(await readFile(selectionPath)).equals(selectionBytes)) throw new Error("gstack_refresh_selection_changed");
    for (const path of replacements) {
      await mkdir(dirname(join(backup, path)), { recursive: true });
      await copyFile(join(root, path), join(backup, path));
    }
    mutated = true;
    for (const path of replacements) await rename(join(next, path), join(root, path));
    const identity = { ...before.identity, adaptationRevision, manifestChecksum: digest(Buffer.from(manifestBytes)) };
    const verified = await readExecutableBundle(root, identity);
    if (!(await readFile(selectionPath)).equals(selectionBytes)) throw new Error("gstack_refresh_selection_changed");
    // Atomic rename must stay on the selection file's filesystem; only this
    // tiny metadata file lives next to the worktree, never build resources.
    await writeFile(selected, `${JSON.stringify({ root, identity: verified.identity }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(selected, selectionPath);
    accepted = true;
    return { identity, scope: "local-candidate-verifier-refresh-not-client-package", fullTreeCopied: false,
      changedPaths: replacements, previousManifestChecksum: expectedManifestChecksum, releaseEligible: false };
  } finally {
    if (mutated && !accepted) {
      // A partial update cannot pass its old manifest; restore the exact four
      // prior files before removing the only bounded rollback material.
      for (const path of replacements) await copyFile(join(backup, path), join(root, path));
    }
    await rm(selected, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, stageRoot, expectedManifestChecksum, ...extra] = process.argv.slice(2);
  if (!expectedManifestChecksum || extra.length) throw new Error("gstack_refresh_arguments_invalid");
  const result = await refreshExecutableBrowserVerifier({ root, stageRoot, expectedManifestChecksum });
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/executable-refresh-proof.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
