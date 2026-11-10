import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedNodeArguments } from "./run-managed.mjs";
import { sourceAcquisitionPlan, sourceGenerationEnvironment, recoverReviewedSourceIdentity, writeSourceRebuildReceipt } from "./collect-pinned-source.mjs";
import { acquireResourceLease, initResourceWorkspace } from "./resource-workspace.mjs";

test("identical existing source receipts are reusable at retention limit, but changed evidence is never overwritten", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-source-receipt-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "managed");
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const lease = await acquireResourceLease(root);
  try {
    for (const name of ["source-pin-comparison.json", "source-reconstruction.json"]) {
      assert.equal(await writeSourceRebuildReceipt({ env: lease.env, name, record: { fixture: name } }), false);
    }
    for (const name of ["source-pin-comparison.json", "source-reconstruction.json"]) {
      assert.equal(await writeSourceRebuildReceipt({ env: lease.env, name, record: { fixture: name } }), true);
      await assert.rejects(writeSourceRebuildReceipt({ env: lease.env, name, record: { changed: true } }), /source_receipt_changed/);
      assert.deepEqual(JSON.parse(await readFile(join(root, "artifacts/report", name))), { fixture: name });
    }
  } finally { await lease.release(); }
});

test("source identity recovery reconstructs only an exact old content address; no changed file or structure is accepted", () => {
  const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const manifest = { schemaVersion: 1, adaptationRevision: "ling-original", upstream: { revision: "fixed" },
    files: [{ path: "runtime/skill.md", checksum: "sha256:fixture", sizeBytes: 4 }], skills: [{ id: "fixture" }] };
  const original = encode(manifest);
  const expected = { manifestChecksum: `sha256:${createHash("sha256").update(original).digest("hex")}`,
    adaptationRevision: "ling-original" };
  const regenerated = encode({ ...manifest, adaptationRevision: "ling-current" });
  const recovered = recoverReviewedSourceIdentity(regenerated, expected);
  assert.deepEqual(recovered.bytes, original);
  assert.equal(recovered.reconstructed, true);
  assert.equal(recoverReviewedSourceIdentity(original, expected).reconstructed, false);
  for (const changed of [{ ...manifest, upstream: { revision: "different" } }, { ...manifest, files: [] },
    { ...manifest, files: [{ ...manifest.files[0], sizeBytes: 5 }] }, { ...manifest, skills: [{ id: "different" }] },
    { ...manifest, unexpected: true }]) {
    assert.throws(() => recoverReviewedSourceIdentity(encode({ ...changed, adaptationRevision: "ling-current" }), expected),
      /reviewed_source_content_changed/);
  }
});

test("source fetch plan freezes remote/object and excludes user config, credentials and runtime hooks", () => {
  const plan = sourceAcquisitionPlan("/private/selected/scratch", { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "fixture",
    NODE_OPTIONS: "--require unwanted", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "unwanted", GIT_DIR: "/unwanted", GIT_WORK_TREE: "/unwanted", HOME: "/unwanted" });
  assert.equal(plan.repository, "https://github.com/garrytan/gstack");
  assert.equal(plan.revision, "47d639abffa882b8cbb641d7d1dedf08ecada9ec");
  assert.equal(plan.env.HOME, "/private/selected/scratch/home");
  assert.equal(plan.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(plan.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(plan.prefix.includes("credential.helper="));
  assert.ok(plan.prefix.includes("fetch.fsckObjects=true"));
  for (const key of ["OPENAI_API_KEY", "NODE_OPTIONS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_DIR", "GIT_WORK_TREE"]) {
    assert.equal(plan.env[key], undefined, key);
  }
});

test("the entire original generation phase inherits only the isolated Git config and current resource lease", () => {
  const lease = { root: "/selected/resources", scratchPath: "/selected/resources/runs/fixture", token: "fixture-lease" };
  const env = sourceGenerationEnvironment(lease, "/selected/resources/runs/fixture/acquisition", {
    PATH: "/usr/bin:/bin", GIT_DIR: "/outside", GIT_CONFIG_GLOBAL: "/outside/config", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "unwanted", LING_GSTACK_RESOURCE_TOKEN: "unwanted" });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
  assert.equal(env.LING_GSTACK_RESOURCE_TOKEN, lease.token);
  assert.equal(env.TMPDIR, join(lease.scratchPath, "tmp"));
  assert.equal(env.BUN_INSTALL_CACHE_DIR, join(lease.root, "cache/bun"));
});

test("pinned source retrieval has an explicit managed operation without remote/ref override", () => {
  assert.ok(managedNodeArguments("source-fetch", ["/selected/output"])[0].endsWith("collect-pinned-source.mjs"));
  for (const args of [[], ["/selected/output", "bun", "https://other.invalid"], ["--remote=other"]]) {
    assert.throws(() => managedNodeArguments("source-fetch", args), /arguments_invalid/);
  }
});

test("pinned source acquisition refuses an ungoverned invocation before network or output", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-source-admission-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, LANG: "C" };
  const result = spawnSync(process.execPath, ["scripts/gstack/collect-pinned-source.mjs", join(parent, "output")],
    { env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_resource_lease_required/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|git.*failed|fetch.*failed/);
});
