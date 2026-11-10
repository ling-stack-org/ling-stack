import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = path => typeof path === "string" && path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) &&
  !/[\\:\0]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..");
const hashValid = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const scopes = ["client-command-imports", "native-build-imports", "node-browser-build-imports", "diagram-build-imports", "security-sidecar-build-imports"];

// A frozen-source exclusion, only inside private unpublished preparation staging.
// This never updates an installed client or clears compiled-output/license gates.
export async function filterReviewedGstackBuildPackages({ runtimeRoot, stagingRoot,
  expectedNativeBuildChecksum, importReports, target, reviewPath, expectedReviewChecksum }, policy) {
  const fail = code => { throw new Error(`${policy.errorPrefix}_${code}`); };
  const stage = resolve(stagingRoot), runtime = resolve(runtimeRoot);
  const stat = await lstat(stage);
  if (!/^\.gstack-resource-stage-[A-Za-z0-9]+$/.test(basename(stage)) || !stat.isDirectory() || stat.isSymbolicLink() ||
    await realpath(stage) !== stage || runtime !== join(stage, "candidate/runtime") ||
    (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) fail("private_staging_required");
  for (const path of [join(stage, "candidate"), runtime]) {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || await realpath(path) !== path) fail("private_staging_required");
  }
  if (!hashValid(expectedReviewChecksum) || !hashValid(expectedNativeBuildChecksum)) fail("detached_checksums_required");
  const reviewRecord = await readGstackClosureFileRecord(typeof reviewPath === "string" ? resolve(reviewPath) : await realpath(reviewPath),
    { retain: true, maximumBytes: 1024 * 1024 });
  if (reviewRecord.checksum !== expectedReviewChecksum) fail("review_mismatch");
  const review = JSON.parse(reviewRecord.bytes);
  if (review.schemaVersion !== 1 || review.marker !== policy.marker || !Array.isArray(review.references) ||
    !Array.isArray(review.packages) || review.packages.length !== policy.packageCount || !Array.isArray(review.importGraphs) ||
    review.importGraphs.length !== scopes.length || !hashValid(review.sourceManifestChecksum) || !hashValid(review.compilerChecksum)) fail("review_invalid");
  if (target?.platform !== review.target?.platform || target?.arch !== review.target?.arch) fail("target_not_reviewed");
  const candidate = dirname(runtime);
  const nativeRecord = await readGstackClosureFileRecord(join(candidate, "native-build.json"), { retain: true });
  if (nativeRecord.checksum !== expectedNativeBuildChecksum) fail("native_receipt_mismatch");
  const native = JSON.parse(nativeRecord.bytes);
  if (native.deliveryStage !== "native-dependencies" || native.upstreamRevision !== review.upstreamRevision ||
    native.sourceManifestChecksum !== review.sourceManifestChecksum || native.target?.platform !== target.platform ||
    native.target?.arch !== target.arch || !Array.isArray(native.components)) fail("native_receipt_invalid");
  const sourceRecord = await readGstackClosureFileRecord(join(candidate, "source-manifest.json"), { retain: true, maximumBytes: 16 * 1024 * 1024 });
  if (sourceRecord.checksum !== review.sourceManifestChecksum) fail("source_manifest_mismatch");
  const source = JSON.parse(sourceRecord.bytes);
  if (source.deliveryStage !== "source" || source.upstream?.revision !== review.upstreamRevision ||
    !Array.isArray(source.files) || source.files.length !== review.sourceFileCount || source.files.length > 100_000) fail("source_manifest_invalid");
  const references = new Map();
  for (const reference of review.references) {
    if (!canonical(reference.path) || !hashValid(reference.checksum) || !policy.validReference(reference) ||
      references.has(reference.path)) fail("reference_review_invalid");
    references.set(reference.path, reference);
  }
  const packages = review.packages;
  for (const [index, pkg] of packages.entries()) if (pkg.path !== `node_modules/${pkg.name}` || !canonical(pkg.path) ||
    !policy.validPackage(pkg, index, target) || !hashValid(pkg.metadataChecksum)) fail("package_review_invalid");
  const excluded = path => packages.some(pkg => path === pkg.path || path.startsWith(`${pkg.path}/`));

  const verified = new Map(), seenReferences = new Set(), sourcePaths = new Set();
  const rebuilt = new Map();
  for (const component of native.components) {
    if (!canonical(component.path) || !component.path.startsWith("runtime/") || rebuilt.has(component.path) ||
      !hashValid(component.checksum) || !Number.isSafeInteger(component.sizeBytes) || component.sizeBytes < 0) fail("native_component_invalid");
    rebuilt.set(component.path, component);
  }
  for (const file of source.files) {
    if (!canonical(file.path) || sourcePaths.has(file.path) || !hashValid(file.checksum) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) fail("source_path_invalid");
    sourcePaths.add(file.path);
    const expected = rebuilt.get(file.path) ?? file;
    const absolute = join(candidate, file.path);
    const actual = await readGstackClosureFileRecord(absolute, { retain: true, maximumBytes: 16 * 1024 * 1024 });
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail(`source_changed:${file.path}`);
    verified.set(absolute, { checksum: actual.checksum, sizeBytes: actual.sizeBytes });
    if (actual.bytes.includes(Buffer.from(review.marker))) {
      const reference = references.get(file.path);
      if (!reference || reference.checksum !== actual.checksum) fail(`unreviewed_reference:${file.path}`);
      seenReferences.add(file.path);
    }
  }
  if (seenReferences.size !== references.size) fail("reference_census_mismatch");

  if (!Array.isArray(importReports) || importReports.length !== scopes.length ||
    new Set(importReports.map(report => report.dependencyScope)).size !== scopes.length) fail("import_coverage_required");
  for (const scope of scopes) {
    const report = importReports.find(report => report.dependencyScope === scope);
    const pin = review.importGraphs.find(graph => graph.dependencyScope === scope);
    if (!report || !pin || report.sourceManifestChecksum !== review.sourceManifestChecksum ||
      report.compilerChecksum !== review.compilerChecksum || !Array.isArray(report.inputs) ||
      digest(JSON.stringify(report.inputs)) !== pin.inputGraphChecksum || report.inputGraphChecksum !== pin.inputGraphChecksum) fail("import_graph_mismatch");
    for (const input of report.inputs) {
      if (!canonical(input.path) || !hashValid(input.checksum)) fail("import_path_invalid");
      if (excluded(input.path)) fail(`required_import:${input.path}`);
      const absolute = join(runtime, input.path);
      const actual = await readGstackClosureFileRecord(absolute);
      if (actual.checksum !== input.checksum || actual.sizeBytes !== input.sizeBytes) fail(`import_changed:${input.path}`);
      verified.set(absolute, actual);
    }
  }

  const files = [], directories = [], metadataRecords = [];
  async function inventory(path) {
    const absolute = join(runtime, path), stat = await lstat(absolute);
    if (stat.isSymbolicLink() || await realpath(absolute) !== absolute) fail(`linked_resource:${path}`);
    if (stat.isDirectory()) {
      directories.push(path);
      for (const name of (await readdir(absolute)).sort()) await inventory(`${path}/${name}`);
    } else if (stat.isFile()) {
      const record = await readGstackClosureFileRecord(absolute, { maximumBytes: 512 * 1024 * 1024 });
      files.push({ path, ...record });
    } else fail(`resource_kind_invalid:${path}`);
  }
  for (const pkg of packages) {
    const absolute = join(runtime, `${pkg.path}/package.json`);
    const record = await readGstackClosureFileRecord(absolute, { retain: true, maximumBytes: 1024 * 1024 });
    const metadata = JSON.parse(record.bytes);
    if (record.checksum !== pkg.metadataChecksum || metadata.name !== pkg.name || metadata.version !== pkg.version ||
      metadata.bin || !policy.validMetadata(metadata)) fail(`metadata_not_reviewed:${pkg.path}`);
    metadataRecords.push({ path: `${pkg.path}/package.json`, checksum: record.checksum });
    await inventory(pkg.path);
  }
  policy.validateResources?.(files, packages, fail);
  // Check everything before the first unlink. Failure discards owned staging;
  // no source candidate, retained resource generation or installed app is touched.
  for (const [absolute, expected] of verified) {
    const actual = await readGstackClosureFileRecord(absolute);
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail("verified_input_changed");
  }
  for (const file of files) {
    const actual = await readGstackClosureFileRecord(join(runtime, file.path), { maximumBytes: 512 * 1024 * 1024 });
    if (actual.checksum !== file.checksum || actual.sizeBytes !== file.sizeBytes) fail("excluded_input_changed");
  }
  if ((await readGstackClosureFileRecord(join(candidate, "source-manifest.json"))).checksum !== sourceRecord.checksum ||
    (await readGstackClosureFileRecord(join(candidate, "native-build.json"))).checksum !== nativeRecord.checksum ||
    (await readGstackClosureFileRecord(typeof reviewPath === "string" ? resolve(reviewPath) : await realpath(reviewPath))).checksum !== reviewRecord.checksum) fail("detached_inputs_changed");
  for (const file of files) await unlink(join(runtime, file.path));
  for (const path of directories.sort((a, b) => b.split("/").length - a.split("/").length)) await rmdir(join(runtime, path));
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false, target,
    selectionScope: policy.selectionScope, completeRuntimeSelection: "pending",
    compiledArtifactBinding: "pending", reviewChecksum: reviewRecord.checksum,
    sourceManifestChecksum: sourceRecord.checksum, inputNativeBuildChecksum: nativeRecord.checksum,
    sourceFileCount: sourcePaths.size, reviewedReferenceCount: seenReferences.size,
    importGraphs: review.importGraphs, excludedPackages: packages, metadataRecords,
    removedResources: files, removedSizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    pendingGates: ["complete-dynamic-resource-selection", "compiled-output-input-binding", "redistribution-review", "installed-client-acceptance"] };
}
