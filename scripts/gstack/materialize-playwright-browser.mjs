import { chmod, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { verifyBundledBrowser } from "../../packages/core/src/bundled-skill-browser.ts";
import { bundleFile, digest } from "./executable-bundle.mjs";
import { verifyBrowserArchiveCandidates, validateRequiredBrowserArtifacts } from "./inspect-browser-archives.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { resourceCheckpoint } from "./resource-workspace.mjs";

const fail = reason => { throw new Error(`gstack_browser_materialize_${reason}`); };
const hash = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");

/** Extract only independently inspected members into a new exclusively owned tree. */
export async function extractVerifiedBrowserArchive({ zipPath, yauzl, inspected, outputRoot, target, checkpoint = async () => {} }) {
  const records = new Map(inspected.members.map(row => [row.path, row]));
  if (records.size !== inspected.members.length) fail("duplicate_member");
  await mkdir(outputRoot);
  const archive = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false });
  let observed = 0;
  try {
    await new Promise((resolve, reject) => {
      archive.once("error", reject); archive.once("end", resolve);
      archive.on("entry", entry => { (async () => {
        const record = records.get(entry.fileName.replace(/\/$/, ""));
        if (!record) fail("unlisted_member");
        observed++;
        const destination = join(outputRoot, record.path);
        if (record.kind === "directory") await mkdir(destination, { recursive: true });
        else if (record.kind === "file") {
          await mkdir(dirname(destination), { recursive: true });
          const stream = await archive.openReadStreamPromise(entry);
          await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
          const actual = await bundleFile(outputRoot, record.path);
          if (actual.checksum !== record.checksum || actual.sizeBytes !== record.sizeBytes) fail("member_changed");
          if (target.platform !== "win32") await chmod(destination, record.mode & 0o111 ? 0o755 : 0o644);
        }
        if (observed % 100 === 0) await checkpoint();
        archive.readEntry();
      })().catch(reject); });
      archive.readEntry();
    });
    if (observed !== records.size) fail("missing_member");
  } finally { archive.close(); }
  const links = inspected.members.filter(row => row.kind === "link");
  for (const row of links) {
    const knownTarget = records.has(row.resolvedTarget) || row.targetKind === "directory" &&
      inspected.members.some(member => member.path.startsWith(`${row.resolvedTarget}/`));
    if (target.platform !== "darwin" || !knownTarget) fail("link_target_invalid");
    await mkdir(dirname(join(outputRoot, row.path)), { recursive: true });
    await symlink(row.linkTarget, join(outputRoot, row.path));
  }
  // Framework aliases can name Versions/Current before that alias appears in
  // the ZIP. Validate after all authenticated links exist, regardless of order.
  for (const row of links) {
    if (await realpath(join(outputRoot, row.path)) !== join(outputRoot, row.resolvedTarget)) fail("link_target_changed");
  }
  await checkpoint();
}

/** Materialization permits development candidate tests, without granting redistribution approval. */
export async function materializePlaywrightBrowser({ resourceStagePath, archivePath, inspectionPath,
  expectedResourceStageChecksum, expectedArchiveReceiptChecksum, expectedInspectionChecksum,
  browserOutputRoot, cacheOutputRoot, managedRoot, target = { platform: process.platform, arch: process.arch } }) {
  if (!hash(expectedInspectionChecksum) || target.platform !== process.platform || target.arch !== process.arch) fail("detached_host_inputs_required");
  inspectionPath = resolve(inspectionPath);
  if (await realpath(inspectionPath) !== inspectionPath) fail("inspection_alias");
  const receiptBytes = await readFile(join(inspectionPath, "browser-member-inspection.json"));
  if (digest(receiptBytes) !== expectedInspectionChecksum) fail("inspection_changed");
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schemaVersion !== 1 || receipt.deliveryStage !== "browser-archive-member-inspection" ||
    receipt.releaseEligible !== false || receipt.reviewStatus !== "candidate-only" || !isDeepStrictEqual(receipt.target, target) ||
    receipt.archiveReceiptChecksum !== expectedArchiveReceiptChecksum) fail("inspection_identity_invalid");
  const options = { resourceStagePath, archivePath, expectedResourceStageChecksum, expectedArchiveReceiptChecksum, target };
  const verified = await verifyBrowserArchiveCandidates(options);
  if (!isDeepStrictEqual(receipt.source, verified.source.provenance)) fail("inspection_source_changed");
  const inventoryBytes = await readFile(join(inspectionPath, "browser-member-inventory.json"));
  if (digest(inventoryBytes) !== receipt.inventoryChecksum) fail("inventory_changed");
  const inventory = JSON.parse(inventoryBytes);
  if (!isDeepStrictEqual(inventory.target, target) || inventory.archiveReceiptChecksum !== expectedArchiveReceiptChecksum ||
    inventory.upstreamRevision !== verified.receipt.upstreamRevision || !isDeepStrictEqual(inventory.source, receipt.source) ||
    !Array.isArray(inventory.archives) || inventory.archives.length !== 3) fail("inventory_identity_invalid");
  const inspectorNames = ["inspect-browser-archives.mjs", "inspect-browser-zip.mjs", "collect-browser-archives.mjs", "runtime-dependency-audit.mjs", "upstream-lock.json", "publish-staged-directory.mjs"];
  if (!Array.isArray(receipt.inspectorInputChecksums) || !isDeepStrictEqual(receipt.inspectorInputChecksums.map(row => row.path).sort(), inspectorNames.sort()) ||
    !isDeepStrictEqual(inventory.inspectorInputChecksums, receipt.inspectorInputChecksums)) fail("inspector_identity_invalid");
  for (const input of receipt.inspectorInputChecksums) {
    if (!/^[a-z0-9.-]+\.mjs$|^upstream-lock\.json$/.test(input.path) ||
      digest(await readFile(new URL(input.path, import.meta.url))) !== input.checksum) fail("inspector_changed");
  }
  const require = createRequire(join(verified.source.root, "runtime/package.json"));
  const { yauzl } = require(join(verified.source.packagePath, "lib/utilsBundle.js"));
  const inspections = new Map();
  // Reinspect all three immutable archives, including the unused headless-shell evidence.
  for (const archive of verified.receipt.archives) {
    const frozen = inventory.archives.find(row => row.name === archive.name);
    if (!frozen || frozen.archiveChecksum !== archive.checksum) fail("archive_inventory_changed");
    const actual = await inspectBrowserZip({ zipPath: join(verified.root, archive.filename), yauzl, target });
    const required = validateRequiredBrowserArtifacts(archive, actual, target);
    if (!isDeepStrictEqual(actual.members, frozen.members) || Object.entries(required).some(([key, value]) => frozen[key] !== value)) fail("archive_members_changed");
    inspections.set(archive.name, { archive, actual, required });
  }
  const chromium = inspections.get("chromium"), ffmpeg = inspections.get("ffmpeg");
  await resourceCheckpoint(managedRoot, chromium.actual.totalBytes + ffmpeg.actual.totalBytes);
  await extractVerifiedBrowserArchive({ zipPath: join(verified.root, chromium.archive.filename), yauzl,
    inspected: chromium.actual, outputRoot: browserOutputRoot, target, checkpoint: () => resourceCheckpoint(managedRoot) });
  const component = Buffer.from(`${JSON.stringify({ schemaVersion: 1, source: "playwright-registry", target,
    entryPath: chromium.required.executablePath,
    files: chromium.actual.members.filter(row => row.kind === "file").map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes })),
    links: chromium.actual.members.filter(row => row.kind === "link").map(({ path, linkTarget, resolvedTarget }) => ({ path, linkTarget, resolvedTarget })) }, null, 2)}\n`);
  await writeFile(join(browserOutputRoot, "browser-component.json"), component, { flag: "wx" });
  verifyBundledBrowser(browserOutputRoot, digest(component), target);
  await mkdir(cacheOutputRoot);
  await extractVerifiedBrowserArchive({ zipPath: join(verified.root, ffmpeg.archive.filename), yauzl,
    inspected: ffmpeg.actual, outputRoot: join(cacheOutputRoot, `ffmpeg-${ffmpeg.archive.revision}`), target,
    checkpoint: () => resourceCheckpoint(managedRoot) });
  await verifyBrowserArchiveCandidates(options);
  if (digest(await readFile(join(inspectionPath, "browser-member-inspection.json"))) !== expectedInspectionChecksum) fail("inspection_changed");
  return { activation: "package-relative-only", source: "playwright-registry", releaseEligible: false, target,
    componentChecksum: digest(component), entryPath: `../../gstack-browser/${chromium.required.executablePath}`,
    entryChecksum: (await bundleFile(browserOutputRoot, chromium.required.executablePath)).checksum,
    playwrightVersion: verified.source.provenance.playwrightVersion, browserVersion: chromium.archive.browserVersion,
    archiveReceiptChecksum: expectedArchiveReceiptChecksum, inspectionChecksum: expectedInspectionChecksum,
    ffmpeg: { revision: ffmpeg.archive.revision, archiveChecksum: ffmpeg.archive.checksum,
      entryPath: `browser-cache/ffmpeg-${ffmpeg.archive.revision}/${ffmpeg.required.executablePath}`,
      entryChecksum: (await bundleFile(join(cacheOutputRoot, `ffmpeg-${ffmpeg.archive.revision}`), ffmpeg.required.executablePath)).checksum },
    pendingGates: ["exact-archive-license-review", "real-browser-execution", "installed-client-acceptance", "redistribution-authorization"] };
}
