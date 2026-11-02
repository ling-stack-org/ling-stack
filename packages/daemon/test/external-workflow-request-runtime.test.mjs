import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createExternalWorkflowRequestFrameReader, ExternalWorkflowRequestRuntime }
  from "../dist/runtime/sandbox/external-workflow-request-runtime.js";
import { prepareExternalWorkflowRequest, readPreparedExternalWorkflowRequestProfile }
  from "../dist/runtime/sandbox/external-workflow-request-source.js";
import { createProtectedHostStageFixture } from "./support/protected-host-stage-fixture.mjs";

const native = { skip: process.platform !== "darwin", timeout: 15_000 };
const markdown = "---\nsource:\n  kind: github\n  repository: fixture/repository\n---\n";

function requestFixture(t) {
  const container = realpathSync(mkdtempSync("/private/tmp/ling-external-request-runtime-"));
  const root = join(container, "workspace");
  const outside = join(container, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: root }));
  const runtime = supervisor.getExternalWorkflowRequestRuntime();
  assert.ok(runtime, "macOS development Host must provide the fixed request runtime");
  t.after(() => {
    try { supervisor.releaseAll(); }
    finally { rmSync(container, { recursive: true, force: true }); }
  });
  return { container, root, outside, runtime, supervisor };
}

function replaceDecision() {
  return { action: "replace", markdown };
}

function hostReaderFixture(t, source) {
  const child = spawn(process.execPath, ["--eval", source], { stdio: "pipe" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return createExternalWorkflowRequestFrameReader(child);
}

async function rejectsWithin(promise, pattern) {
  let timer;
  try {
    await assert.rejects(Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("reader failure deadline exceeded")), 1_000); }),
    ]), pattern);
  } finally {
    clearTimeout(timer);
  }
}

test("Host rejects malformed request-worker frames", async t => {
  const reader = hostReaderFixture(t, 'process.stdout.write("{not-json}\\n"); setInterval(() => {}, 1000);');
  await rejectsWithin(reader.next(), /external_workflow_request_frame_invalid/u);
});

test("Host bounds aggregate request-worker stdout", async t => {
  const reader = hostReaderFixture(t,
    'const line = JSON.stringify({ type: "noise", payload: "x".repeat(1024) }) + "\\n"; '
      + 'process.stdout.write(line.repeat(5000)); setInterval(() => {}, 1000);');
  await new Promise(resolve => setTimeout(resolve, 250));
  await rejectsWithin(reader.next(), /external_workflow_request_output_budget/u);
});

test("Host bounds request-worker stderr", async t => {
  const reader = hostReaderFixture(t,
    'process.stderr.write("x".repeat(64 * 1024 + 1)); setInterval(() => {}, 1000);');
  await rejectsWithin(reader.next(), /external_workflow_request_stderr_budget/u);
});

test("Host rejects a request worker whose stdout ends before a frame", async t => {
  const reader = hostReaderFixture(t, 'process.stdout.end(); setInterval(() => {}, 1000);');
  await rejectsWithin(reader.next(), /external_workflow_request_closed/u);
});

test("request worker rejects root replacement after snapshot without writing either root", native, async t => {
  const f = requestFixture(t);
  const moved = join(f.container, "moved-workspace");
  let decisions = 0;
  const execution = f.runtime.execute({
    root: f.root,
    assertCurrentAuthority() {},
    decide(snapshot) {
      decisions += 1;
      assert.equal(snapshot.exists, false);
      renameSync(f.root, moved);
      mkdirSync(f.root, { mode: 0o700 });
      return replaceDecision();
    },
  });
  await assert.rejects(execution, /workflow_path_changed|workflow_parent_not_directory/u);
  assert.equal(decisions, 1, "a failed request must not be replayed");
  assert.equal(existsSync(join(f.root, "WORKFLOW.md")), false);
  assert.equal(existsSync(join(moved, "WORKFLOW.md")), false);
});

test("request worker rejects a target replaced after snapshot and preserves both files", native, async t => {
  const f = requestFixture(t);
  const target = join(f.root, "WORKFLOW.md");
  const displaced = join(f.root, "WORKFLOW.old.md");
  const original = "invalid original\n";
  const replacement = "replacement sentinel\n";
  writeFileSync(target, original, { flag: "wx", mode: 0o600 });
  let decisions = 0;
  const execution = f.runtime.execute({
    root: f.root,
    assertCurrentAuthority() {},
    decide(snapshot) {
      decisions += 1;
      assert.equal(snapshot.markdown, original);
      renameSync(target, displaced);
      writeFileSync(target, replacement, { flag: "wx", mode: 0o600 });
      return replaceDecision();
    },
  });
  await assert.rejects(execution, /workflow_file_changed/u);
  assert.equal(decisions, 1, "a changed target must not be retried");
  assert.equal(readFileSync(target, "utf8"), replacement);
  assert.equal(readFileSync(displaced, "utf8"), original);
});

test("request worker rejects replacement through a hard link and preserves outside bytes", native, async t => {
  const f = requestFixture(t);
  const outsideFile = join(f.outside, "shared.md");
  const target = join(f.root, "WORKFLOW.md");
  const original = "outside hard-link sentinel\n";
  writeFileSync(outsideFile, original, { flag: "wx", mode: 0o600 });
  linkSync(outsideFile, target);
  const execution = f.runtime.execute({
    root: f.root,
    assertCurrentAuthority() {},
    decide: replaceDecision,
  });
  await assert.rejects(execution, /workflow_file_changed/u);
  assert.equal(readFileSync(outsideFile, "utf8"), original);
  assert.equal(readFileSync(target, "utf8"), original);
});

test("request worker treats a concurrent target as EEXIST and never replays the write", native, async t => {
  const f = requestFixture(t);
  const target = join(f.root, "WORKFLOW.md");
  const sentinel = "concurrent target sentinel\n";
  let decisions = 0;
  const execution = f.runtime.execute({
    root: f.root,
    assertCurrentAuthority() {},
    decide(snapshot) {
      decisions += 1;
      assert.equal(snapshot.exists, false);
      writeFileSync(target, sentinel, { flag: "wx", mode: 0o600 });
      return replaceDecision();
    },
  });
  await assert.rejects(execution, /EEXIST/u);
  assert.equal(decisions, 1);
  assert.equal(readFileSync(target, "utf8"), sentinel);
});

test("request worker does not follow or retry a concurrent parent creation", native, async t => {
  const f = requestFixture(t);
  const parent = join(f.root, "conflict-parent");
  let decisions = 0;
  const execution = f.runtime.execute({
    root: f.root,
    workflowPath: "conflict-parent/new/WORKFLOW.md",
    assertCurrentAuthority() {},
    decide(snapshot) {
      decisions += 1;
      assert.equal(snapshot.exists, false);
      mkdirSync(parent, { mode: 0o700 });
      return replaceDecision();
    },
  });
  await assert.rejects(execution, /EEXIST/u);
  assert.equal(decisions, 1, "a parent conflict must not replay the decision");
  assert.deepEqual(readdirSync(parent), []);
});

test("request worker rejects dangling links, non-directories and real EACCES without a decision", native, async t => {
  const f = requestFixture(t);
  const dangling = join(f.root, "dangling");
  symlinkSync(join(f.root, "missing"), dangling, "dir");
  await assert.rejects(f.runtime.execute({ root: f.root, workflowPath: "dangling/WORKFLOW.md",
    assertCurrentAuthority() {}, decide() { assert.fail("dangling link reached decision"); } }), /ENOENT/u);

  const parentFile = join(f.root, "parent-file");
  writeFileSync(parentFile, "sentinel\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(f.runtime.execute({ root: f.root, workflowPath: "parent-file/WORKFLOW.md",
    assertCurrentAuthority() {}, decide() { assert.fail("non-directory reached decision"); } }), /ENOTDIR|workflow_parent_not_directory/u);

  const denied = join(f.root, "denied");
  mkdirSync(denied, { mode: 0o700 });
  chmodSync(denied, 0o000);
  try {
    await assert.rejects(f.runtime.execute({ root: f.root, workflowPath: "denied/WORKFLOW.md",
      assertCurrentAuthority() {}, decide() { assert.fail("EACCES path reached decision"); } }), /EACCES|permission denied/u);
  } finally {
    chmodSync(denied, 0o700);
  }
  assert.equal(existsSync(join(denied, "WORKFLOW.md")), false);
});

test("request cancellation terminates the actor, releases its lease and performs no replay", native, async t => {
  const f = requestFixture(t);
  const abortController = new AbortController();
  let decisions = 0;
  const cancelled = f.runtime.execute({
    root: f.root,
    workflowPath: "cancelled.md",
    signal: abortController.signal,
    assertCurrentAuthority() {},
    decide() { decisions += 1; return replaceDecision(); },
  });
  abortController.abort(new Error("fixture request cancelled"));
  await assert.rejects(cancelled, /fixture request cancelled|external_workflow_request_aborted/u);
  assert.equal(decisions, 0);
  assert.equal(existsSync(join(f.root, "cancelled.md")), false);

  const next = await f.runtime.execute({ root: f.root, workflowPath: "after-cancel.md",
    assertCurrentAuthority() {}, decide: replaceDecision });
  assert.equal(next.result.markdown, markdown);
});

test("request timeout terminates the child, performs no write and releases the lease", native, async t => {
  const f = requestFixture(t);
  const nodePath = realpathSync(process.execPath);
  const timed = new ExternalWorkflowRequestRuntime({
    node: { path: nodePath, sha256: createHash("sha256").update(readFileSync(nodePath)).digest("hex") },
    timeoutMs: 1,
  }, f.supervisor.getProtectedHostStageRegistry());
  let decisions = 0;
  await assert.rejects(timed.execute({ root: f.root, workflowPath: "timed-out.md",
    assertCurrentAuthority() {}, decide() { decisions += 1; return replaceDecision(); } }),
  /external_workflow_request_timeout/u);
  assert.equal(decisions, 0);
  assert.equal(existsSync(join(f.root, "timed-out.md")), false);
  const next = await f.runtime.execute({ root: f.root, workflowPath: "after-timeout.md",
    assertCurrentAuthority() {}, decide: replaceDecision });
  assert.equal(next.result.markdown, markdown);
});

test("Supervisor release invalidates cached request runtime, stops in-flight work and releases its actor lease", native,
  async t => {
    const f = requestFixture(t);
    assert.equal(f.supervisor.getExternalWorkflowRequestRuntime(), f.runtime);
    const target = join(f.root, "released.md");
    let decisions = 0;
    const execution = f.runtime.execute({
      root: f.root,
      workflowPath: "released.md",
      assertCurrentAuthority() {},
      decide() {
        decisions += 1;
        f.supervisor.releaseAll();
        return replaceDecision();
      },
    });
    await assert.rejects(execution, /external_workflow_request_runtime_released/u);
    assert.equal(decisions, 1);
    assert.equal(existsSync(target), false);
    assert.throws(() => f.supervisor.getExternalWorkflowRequestRuntime(), /runtime_supervisor_released/u);
    await assert.rejects(f.runtime.execute({ root: f.root, workflowPath: "after-release.md",
      assertCurrentAuthority() {}, decide: replaceDecision }), /external_workflow_request_runtime_released/u);

    const successor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: f.root }));
    t.after(() => successor.releaseAll());
    const successorRuntime = successor.getExternalWorkflowRequestRuntime();
    assert.ok(successorRuntime);
    const result = await successorRuntime.execute({ root: f.root, workflowPath: "successor.md",
      assertCurrentAuthority() {}, decide: replaceDecision });
    assert.equal(result.result.markdown, markdown);
  });

test("protected stage and request actor exclude each other in both directions", native, async t => {
  const f = createProtectedHostStageFixture(t);
  const requestRuntime = f.supervisor.getExternalWorkflowRequestRuntime();
  assert.ok(requestRuntime);
  f.register();
  await assert.rejects(requestRuntime.execute({ root: f.cwd, assertCurrentAuthority() {}, decide: replaceDecision }),
    /protected_host_request_actor_busy/u);
});

test("an active request actor prevents a new protected stage until it settles", native, async t => {
  const f = createProtectedHostStageFixture(t);
  const requestRuntime = f.supervisor.getExternalWorkflowRequestRuntime();
  assert.ok(requestRuntime);
  const execution = requestRuntime.execute({ root: f.cwd, assertCurrentAuthority() {}, decide: replaceDecision });
  assert.throws(() => f.register(), /protected_host_request_actor_active/u);
  const result = await execution;
  assert.equal(result.result.markdown, markdown);
  const stage = f.register();
  f.registry.closeStage(stage);
});

test("fixed request Seatbelt profile denies process fork and network", native, t => {
  const f = requestFixture(t);
  const scratch = join(f.container, "profile-scratch");
  mkdirSync(scratch, { mode: 0o700 });
  const prepared = prepareExternalWorkflowRequest({ root: f.root, scratch,
    executable: realpathSync(process.execPath), runtimeReadRoots: [] });
  const script = String.raw`
    const { spawnSync } = require("node:child_process");
    const net = require("node:net");
    const fork = spawnSync("/usr/bin/true", [], { encoding: "utf8" });
    const result = { fork: fork.error && fork.error.code || fork.status };
    const server = net.createServer();
    const finish = value => { result.network = value; process.stdout.write(JSON.stringify(result)); };
    server.once("error", error => finish(error && error.code));
    server.listen(0, "127.0.0.1", () => server.close(() => finish("allowed")));
    setTimeout(() => finish("timeout"), 1000).unref();
  `;
  const child = spawnSync("/usr/bin/sandbox-exec", ["-p", readPreparedExternalWorkflowRequestProfile(prepared),
    realpathSync(process.execPath), "--eval", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(["EPERM", "EACCES"].includes(result.fork), JSON.stringify(result));
  assert.ok(["EPERM", "EACCES"].includes(result.network), JSON.stringify(result));
});
