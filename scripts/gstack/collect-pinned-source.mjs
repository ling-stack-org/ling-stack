import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundledSkillSource } from "../../packages/core/dist/bundled-skill-source.js";
import { sourceBuildEnvironment } from "./build-source-bundle.mjs";
import { managedResourceWrite, requireResourceLease, resourceCheckpoint } from "./resource-workspace.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url)));
const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url)));
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Fixed remote and object only. User Git config, helpers, hooks and submodules
// are not part of the source acquisition contract.
export function sourceAcquisitionPlan(staging, inherited = process.env) {
  if (lock.repository !== "https://github.com/garrytan/gstack" || !/^[a-f0-9]{40}$/.test(lock.revision)
    || reviewed.upstreamRevision !== lock.revision) throw new Error("gstack_source_acquisition_pin_invalid");
  const env = { ...sourceBuildEnvironment({ staging, inherited }), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1" };
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never", "-c", "http.followRedirects=false", "-c", "fetch.fsckObjects=true"];
  return { env, prefix, revision: lock.revision, repository: lock.repository };
}

export function sourceGenerationEnvironment(lease, staging, inherited = process.env) {
  return { ...sourceAcquisitionPlan(staging, inherited).env, LING_GSTACK_RESOURCE_ROOT: lease.root,
    LING_GSTACK_RESOURCE_TOKEN: lease.token, TMPDIR: join(lease.scratchPath, "tmp"),
    TMP: join(lease.scratchPath, "tmp"), TEMP: join(lease.scratchPath, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(lease.root, "cache/bun") };
}

export function compareSourceManifest(bytes) {
  const manifest = JSON.parse(bytes);
  return { schemaVersion: 1, scope: "source-rebuild-comparison-not-approval", upstreamRevision: lock.revision,
    actualManifestChecksum: digest(bytes), expectedManifestChecksum: reviewed.manifestChecksum,
    actualAdaptationRevision: manifest.adaptationRevision, expectedAdaptationRevision: reviewed.adaptationRevision,
    fileCount: manifest.files.length, skillCount: manifest.skills.length,
    reviewedManifestMatched: digest(bytes) === reviewed.manifestChecksum,
    priorManifestMatchedAfterMetadataOnlySubstitution: digest(Buffer.from(`${JSON.stringify({ ...manifest,
      adaptationRevision: reviewed.adaptationRevision }, null, 2)}\n`)) === reviewed.manifestChecksum };
}

// Recover the exact previously reviewed artifact, never approve a new recipe.
// This check is over every serialized byte, not just its file hashes.
export function recoverReviewedSourceIdentity(bytes, expected = reviewed) {
  if (digest(bytes) === expected.manifestChecksum) return { bytes, reconstructed: false };
  const restored = Buffer.from(`${JSON.stringify({ ...JSON.parse(bytes),
    adaptationRevision: expected.adaptationRevision }, null, 2)}\n`);
  if (digest(restored) !== expected.manifestChecksum) throw new Error("gstack_reviewed_source_content_changed");
  return { bytes: restored, reconstructed: true };
}

export async function writeSourceRebuildReceipt({ env = process.env, name, record }) {
  if (!["source-pin-comparison.json", "source-reconstruction.json"].includes(name)) throw new Error("gstack_source_receipt_name_invalid");
  const lease = await requireResourceLease(env), report = join(lease.root, "artifacts/report", name);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (bytes.length > 16 * 1024) throw new Error("gstack_source_receipt_over_budget");
  if (await lstat(report).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    const previous = await readGstackClosureFileRecord(report, { retain: true, maximumBytes: 16 * 1024 });
    if (!previous.bytes.equals(bytes)) throw new Error("gstack_source_receipt_changed");
    return true;
  }
  await managedResourceWrite(report, { kind: "report", additionalBytes: bytes.length, env });
  await mkdir(dirname(report), { recursive: true, mode: 0o700 });
  await writeFile(report, bytes, { flag: "wx", mode: 0o600 });
  return false;
}

export async function collectPinnedSource({ outputPath, bunCommand = "bun", onProgress = () => {} }) {
  const output = resolve(outputPath);
  const lease = await managedResourceWrite(output, { kind: "source", additionalBytes: 512 * 1024 ** 2 });
  if (await lstat(output).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    throw new Error("gstack_source_output_exists");
  }
  const buildInputs = ["render-upstream.ts", "build-source-bundle.mjs", "upstream-lock.json"];
  const currentRecipe = async () => Buffer.concat(await Promise.all(buildInputs.map(path => readFile(new URL(path, import.meta.url)))));
  const recipeBytes = await currentRecipe();
  const work = await mkdtemp(join(lease.scratchPath, "source-acquisition-"));
  try {
    const plan = sourceAcquisitionPlan(work), checkout = join(work, "checkout"), candidate = join(work, "source");
    for (const path of [checkout, plan.env.HOME, plan.env.TMPDIR]) await mkdir(path, { recursive: true });
    const git = args => execFileSync("git", [...plan.prefix, ...args], { cwd: checkout, env: plan.env,
      encoding: "utf8", maxBuffer: 1024 ** 2, timeout: 180_000 }).trim();
    onProgress(`acquire fixed GStack object ${plan.revision}`);
    git(["init", "--quiet", "--template="]);
    git(["fetch", "--quiet", "--depth=1", "--no-tags", "--recurse-submodules=no", plan.repository, plan.revision]);
    git(["checkout", "--quiet", "--detach", plan.revision]);
    if (git(["rev-parse", "HEAD"]) !== plan.revision || git(["status", "--porcelain"])) {
      throw new Error("gstack_source_acquisition_identity_mismatch");
    }
    await resourceCheckpoint(lease.root);
    onProgress("render fixed source and compare the existing reviewed source manifest");
    // The original builder also invokes Git. Run that whole phase with the same
    // isolated config, not the collector process's possibly injected Git env.
    const built = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./build-source-bundle.mjs", import.meta.url)),
      checkout, candidate, bunCommand], { cwd: work, env: sourceGenerationEnvironment(lease, work),
      encoding: "utf8", maxBuffer: 1024 ** 2, timeout: 180_000 }));
    const comparison = compareSourceManifest(await readFile(join(candidate, "manifest.json")));
    onProgress(JSON.stringify(comparison));
    if (!comparison.reviewedManifestMatched) {
      await writeSourceRebuildReceipt({ name: "source-pin-comparison.json", record: comparison });
    }
    await verifyBundledSkillSource({ rootPath: candidate, expectedUpstreamRevision: plan.revision,
      expectedSkillIds: lock.skillIds, expectedAdaptationRevision: `ling-${digest(recipeBytes).slice(7)}` });
    if (!recipeBytes.equals(await currentRecipe())) throw new Error("gstack_source_recipe_changed");
    const recovered = recoverReviewedSourceIdentity(await readFile(join(candidate, "manifest.json")));
    if (recovered.reconstructed) {
      await writeFile(join(candidate, "manifest.json"), recovered.bytes);
      await writeSourceRebuildReceipt({ name: "source-reconstruction.json", record: { ...comparison, scope: "reconstructed-not-new-approval",
        actualRecipeChecksum: digest(recipeBytes), restoredArtifactChecksum: digest(recovered.bytes),
        currentRecipeApprovedByPriorRecord: false, reviewedPinsChanged: false } });
    }
    const verified = await verifyBundledSkillSource({ rootPath: candidate, expectedUpstreamRevision: plan.revision,
      expectedSkillIds: lock.skillIds, expectedManifestChecksum: reviewed.manifestChecksum,
      expectedAdaptationRevision: reviewed.adaptationRevision });
    await resourceCheckpoint(lease.root);
    await mkdir(dirname(output), { recursive: true });
    // Reserve exclusively; never replace another generation, even when empty.
    await mkdir(output, { mode: 0o700 });
    try { await rename(candidate, output); }
    catch (error) { await rmdir(output).catch(() => {}); throw error; }
    return { ...built, generatedManifestChecksum: built.manifestChecksum, manifestChecksum: verified.manifestChecksum,
      output, repository: plan.repository, reviewedManifestMatched: true, reconstructed: recovered.reconstructed,
      currentRecipeApprovedByPriorRecord: false };
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, bunCommand, ...extra] = process.argv.slice(2);
  if (!outputPath || extra.length) throw new Error("gstack_source_acquisition_arguments_invalid");
  console.log(JSON.stringify(await collectPinnedSource({ outputPath, bunCommand, onProgress: console.error })));
}
