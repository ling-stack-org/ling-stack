import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJson } from "./manifest.mjs";
import { parseTrialManifest, renderTrialPreflightMarkdown, trialPreflight } from "./trial-preflight.mjs";
import { runCli } from "./index.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceFixtureRoot = resolve(repoRoot, "fixtures/framework-assurance");
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown): boolean => (error as { code?: string })?.code === expected;
const noPortConflict = async () => ({ available: true, blocker: null });

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ling-trial-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixtureCopy(t: test.TestContext): Promise<{ root: string; manifest: Record<string, unknown> }> {
  const root = await temporary(t);
  for (const directory of ["cases", "controls", "suites", "trials"]) {
    await cp(join(sourceFixtureRoot, directory), join(root, directory), { recursive: true });
  }
  const manifest = parseJson(await readFile(join(root, "trials/t01-review.json"), "utf8")) as Record<string, unknown>;
  return { root, manifest };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withLingStackHome<T>(value: string, action: () => Promise<T>): Promise<T> {
  const prior = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = value;
  try {
    return await action();
  } finally {
    if (prior === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = prior;
  }
}

function resourcePaths(manifest: Record<string, unknown>): Record<string, string> {
  const resources = manifest.resources as { paths: Record<string, string> };
  return resources.paths;
}

test("T01 trial preflight freezes inputs and produces review-only readiness without execution authority", async t => {
  const { root: fixtureRoot } = await fixtureCopy(t);
  const resourceRoot = await temporary(t);
  const paths = resourcePaths(parseJson(await readFile(join(fixtureRoot, "trials/t01-review.json"), "utf8")) as Record<string, unknown>);
  const home = join(resourceRoot, paths.lingStackHome);
  const reportOutput = join(await temporary(t), "separate-report");
  const report = await withLingStackHome(home, () => trialPreflight({
    repoRoot, fixtureRoot, resourceRoot, reportOutputDir: reportOutput, probePort: noPortConflict,
  }));

  assert.equal(report.status, "ready-for-review");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.admission.executionAuthorized, false);
  assert.equal(report.externalProviderCalls, 0);
  assert.equal(report.ordinaryRunsDispatched, 0);
  assert.equal(report.userStoresInitialized, 0);
  assert.equal(report.taskCodeExecuted, false);
  assert.equal(report.task.taskId, "T01");
  assert.equal(report.provider.providerId, "review-only-provider");
  assert.ok(report.checks.every(item => item.status === "pass"));
  assert.match(renderTrialPreflightMarkdown(report), /ready-for-review/u);
  assert.doesNotMatch(renderTrialPreflightMarkdown(report), new RegExp(resourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
});

test("trial input digest drift is rejected before resource probing", async t => {
  const { root: fixtureRoot, manifest } = await fixtureCopy(t);
  const task = manifest.task as { inputDigests: Record<string, string> };
  task.inputDigests.promptBytes = "0".repeat(64);
  await writeJson(join(fixtureRoot, "trials/t01-review.json"), manifest);
  let probes = 0;
  await assert.rejects(trialPreflight({
    repoRoot, fixtureRoot, resourceRoot: await temporary(t), reportOutputDir: await temporary(t),
    probePort: async () => { probes += 1; return noPortConflict(); },
  }), code("artifact_digest_mismatch"));
  assert.equal(probes, 0);
});

test("symlinks, nonempty directories, wrong LING_STACK_HOME, port conflicts and low capacity block review", async t => {
  const { root: fixtureRoot, manifest } = await fixtureCopy(t);
  const resourceRoot = await temporary(t);
  const paths = resourcePaths(manifest);
  await mkdir(join(resourceRoot, paths.workspace), { recursive: true });
  await writeFile(join(resourceRoot, paths.workspace, "existing.txt"), "owned elsewhere\n");
  const outside = await temporary(t);
  await symlink(outside, join(resourceRoot, paths.lingStackHome));

  const report = await withLingStackHome(join(resourceRoot, "wrong-home"), () => trialPreflight({
    repoRoot, fixtureRoot, resourceRoot, reportOutputDir: join(resourceRoot, "report"),
    probePort: async ({ port }) => ({ available: port !== 39124, blocker: port === 39124 ? "port_in_use" : null }),
  }));
  assert.equal(report.status, "blocked");
  assert.equal(report.executionAuthorized, false);
  for (const blocker of ["resource_symlink", "resource_directory_not_empty", "ling_stack_home_mismatch", "port_in_use",
    "report_output_conflict"]) assert.ok(report.blockers.includes(blocker), blocker);
});

test("resource capacity below the frozen minimum blocks review", async t => {
  const { root: fixtureRoot } = await fixtureCopy(t);
  const resourceRoot = await temporary(t);
  const paths = resourcePaths(parseJson(await readFile(join(fixtureRoot, "trials/t01-review.json"), "utf8")) as Record<string, unknown>);
  const reportOutput = await temporary(t);
  const report = await withLingStackHome(join(resourceRoot, paths.lingStackHome), () => trialPreflight({
    repoRoot, fixtureRoot, resourceRoot, reportOutputDir: reportOutput, probePort: noPortConflict,
    measureResourcesFn: async () => ({ availableParallelism: 0, freeMemoryBytes: 0, freeDiskBytes: 0, load1: 999 }),
  }));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("resource_capacity_below_minimum"));
});

test("a resource root inside the checkout is a hard blocker", async t => {
  const { root: fixtureRoot } = await fixtureCopy(t);
  const resourceRoot = repoRoot;
  const paths = resourcePaths(parseJson(await readFile(join(fixtureRoot, "trials/t01-review.json"), "utf8")) as Record<string, unknown>);
  const reportOutput = await temporary(t);
  const report = await withLingStackHome(join(resourceRoot, paths.lingStackHome), () => trialPreflight({
    repoRoot, fixtureRoot, resourceRoot, reportOutputDir: reportOutput, probePort: noPortConflict,
  }));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("resource_root_inside_checkout"));
});

test("a parent symlink into the checkout cannot disguise the resource root", async t => {
  const { root: fixtureRoot } = await fixtureCopy(t);
  const parent = await temporary(t);
  const alias = join(parent, "checkout-alias");
  await symlink(repoRoot, alias, "dir");
  const resourceRoot = join(alias, "trial-root");
  const reportOutput = await temporary(t);
  const report = await withLingStackHome(join(resourceRoot, "runtime-home"), () => trialPreflight({
    repoRoot, fixtureRoot, resourceRoot, reportOutputDir: reportOutput, probePort: noPortConflict,
  }));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("resource_root_inside_checkout"));
});

test("trial admission rejects implicit Provider selection and execution authority", async t => {
  const { manifest } = await fixtureCopy(t);
  const implicit = clone(manifest);
  (implicit.provider as { providerId: string }).providerId = "auto";
  assert.throws(() => parseTrialManifest(implicit), code("invalid_manifest"));
  const unauthorized = clone(manifest);
  (unauthorized.admission as { executionAuthorized: boolean }).executionAuthorized = true;
  assert.throws(() => parseTrialManifest(unauthorized), code("invalid_manifest"));
});

test("only the reviewed T01 manifest path and digest can enter preflight", async t => {
  const { root: fixtureRoot, manifest } = await fixtureCopy(t);
  await writeJson(join(fixtureRoot, "trials/other.json"), manifest);
  await assert.rejects(trialPreflight({
    repoRoot, fixtureRoot, trialPath: "trials/other.json", resourceRoot: await temporary(t), reportOutputDir: await temporary(t),
    probePort: noPortConflict,
  }), code("invalid_manifest"));
  (manifest.provider as { providerId: string }).providerId = "paid-provider";
  await writeJson(join(fixtureRoot, "trials/t01-review.json"), manifest);
  await assert.rejects(trialPreflight({
    repoRoot, fixtureRoot, resourceRoot: await temporary(t), reportOutputDir: await temporary(t),
    probePort: noPortConflict,
  }), code("artifact_digest_mismatch"));
});

test("CLI publishes JSON and Markdown for a ready review-only preflight", async t => {
  const { root: fixtureRoot } = await fixtureCopy(t);
  const resourceRoot = await temporary(t);
  const paths = resourcePaths(parseJson(await readFile(join(fixtureRoot, "trials/t01-review.json"), "utf8")) as Record<string, unknown>);
  const output = join(await temporary(t), "report");
  const result = await withLingStackHome(join(resourceRoot, paths.lingStackHome), () => runCli([
    "trial-preflight", "--trial", "trials/t01-review.json", "--resource-root", resourceRoot, "--output", output,
  ], { repoRoot, fixtureRoot, probePort: noPortConflict }));
  assert.equal(result.exitCode, 0);
  const summary = JSON.parse(result.text) as { files: { result: string; markdown: string } };
  const report = JSON.parse(await readFile(summary.files.result, "utf8")) as { status: string; executionAuthorized: boolean };
  assert.equal(report.status, "ready-for-review");
  assert.equal(report.executionAuthorized, false);
  assert.match(await readFile(summary.files.markdown, "utf8"), /zero-dispatch preflight/u);
});
