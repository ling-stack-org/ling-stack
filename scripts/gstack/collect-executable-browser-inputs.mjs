import { lstat, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectGstackBrowserArchives } from "./collect-browser-archives.mjs";
import { collectUngoogledChromiumCandidate } from "./collect-ungoogled-chromium.mjs";
import { inspectUngoogledDmg } from "./inspect-ungoogled-dmg.mjs";
import { localBrowserPin } from "./materialize-local-browser.mjs";
import { bundleFile } from "./executable-bundle.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";

const toolNames = ["collect-executable-browser-inputs.mjs", "collect-browser-archives.mjs", "collect-ungoogled-chromium.mjs",
  "ungoogled-chromium-candidate.json", "inspect-ungoogled-dmg.mjs", "inspect-browser-zip.mjs", "inspect-chromium-credits.mjs",
  "chromium-data-pack.mjs", "materialize-local-browser.mjs", "executable-bundle.mjs", "runtime-dependency-audit.mjs", "upstream-lock.json", "public-github-metadata.mjs"];
const toolInputs = () => Promise.all(toolNames.map(path => bundleFile(fileURLToPath(new URL("./", import.meta.url)), path)));
const exists = path => lstat(path).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });

export function verifyBrowserInspectionPins(inspection) {
  if (inspection?.readonlyMountDetached !== true) throw new Error("gstack_browser_inspection_detach_unknown");
  if (inspection.transport?.checksum !== localBrowserPin.transportChecksum || inspection.inventoryChecksum !== localBrowserPin.inventoryChecksum
    || inspection.browserVersion !== localBrowserPin.version || inspection.target?.platform !== localBrowserPin.target.platform
    || inspection.target?.arch !== localBrowserPin.target.arch) throw new Error("gstack_browser_inspection_not_reproducible");
}

// One browser generation contains the related archives and inspection. Temporary
// DMG mounts live outside lease scratch: an unsuccessful detach must never be
// recursively removed by the supervisor's ordinary scratch cleanup.
export async function collectExecutableBrowserInputs({ resourceStagePath, outputPath, expectedResourceStageChecksum,
  onProgress = () => {} }) {
  const output = resolve(outputPath);
  if (await exists(output)) throw new Error("gstack_browser_inputs_output_exists");
  const lease = await managedResourceWrite(output, { kind: "browser", additionalBytes: 2 * 1024 ** 3 });
  const inputs = await toolInputs();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(dirname(output), ".gstack-browser-inputs-"));
  const candidate = join(work, "candidate");
  const acquire = await mkdtemp(join(lease.scratchPath, "browser-acquire-"));
  let inspectionMayBeMounted = false;
  try {
    await mkdir(candidate);
    const options = { resourceStagePath, expectedResourceStageChecksum, onProgress };
    const archives = await collectGstackBrowserArchives({ ...options, outputPath: join(acquire, "archives") });
    await collectUngoogledChromiumCandidate({ ...options, outputPath: join(acquire, "ungoogled") });
    await rename(join(acquire, "archives"), join(candidate, "archives"));
    await rename(join(acquire, "ungoogled"), join(candidate, "ungoogled"));
    const expectedCandidateChecksum = (await bundleFile(join(candidate, "ungoogled"), "ungoogled-candidate.json")).checksum;
    inspectionMayBeMounted = true;
    const inspection = await inspectUngoogledDmg({ candidatePath: join(candidate, "ungoogled"), expectedCandidateChecksum,
      resourceStagePath, outputPath: join(candidate, "inspection"), onProgress });
    if (inspection.readonlyMountDetached !== true) throw new Error("gstack_browser_inspection_detach_unknown");
    inspectionMayBeMounted = false;
    verifyBrowserInspectionPins(inspection);
    if (JSON.stringify(inputs) !== JSON.stringify(await toolInputs())) throw new Error("gstack_browser_inputs_tools_changed");
    const receipt = { schemaVersion: 1, scope: "fixed-browser-inputs-not-release-approval", releaseEligible: false,
      resourceStageChecksum: expectedResourceStageChecksum, browserPin: localBrowserPin, toolInputs: inputs,
      archiveReceiptChecksum: (await bundleFile(join(candidate, "archives"), "browser-archives.json")).checksum,
      ungoogledReceiptChecksum: expectedCandidateChecksum,
      inspectionReceiptChecksum: (await bundleFile(join(candidate, "inspection"), "ungoogled-inspection.json")).checksum,
      archiveCount: archives.archives.length, readonlyMountDetached: true };
    await writeFile(join(candidate, "browser-inputs.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await resourceCheckpoint(lease.root);
    await mkdir(output, { mode: 0o700 });
    try { await rename(candidate, output); }
    catch (error) { await rmdir(output).catch(() => {}); throw error; }
    return receipt;
  } finally {
    await rm(acquire, { recursive: true, force: true });
    // A retained private staging directory requires inspection, not auto-retry.
    if (!inspectionMayBeMounted) await rm(work, { recursive: true, force: true });
    else onProgress(`inspection failed; retain owned staging for explicit mount review: ${work}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourceStagePath, outputPath, expectedResourceStageChecksum, ...extra] = process.argv.slice(2);
  if (!expectedResourceStageChecksum || extra.length) throw new Error("gstack_browser_inputs_arguments_invalid");
  console.log(JSON.stringify(await collectExecutableBrowserInputs({ resourceStagePath, outputPath, expectedResourceStageChecksum,
    onProgress: console.error })));
}
