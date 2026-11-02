import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  compileExecutionSandboxPolicy,
  createDefaultApprovalPolicy,
  resolveSessionRunPolicy,
} from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import {
  macosSandboxCommandFingerprint,
  prepareMacosSandboxCommand,
  readMacosSandboxBackendIdentity,
} from "../dist/runtime/sandbox/macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../dist/runtime/sandbox/macos-seatbelt-profile.js";

const native = { skip: process.platform !== "darwin", timeout: 15_000 };
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function waitForPath(path, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`controlled race timed out waiting for ${path}`);
    Atomics.wait(sleeper, 0, 0, 5);
  }
}

function treeSnapshot(directory, prefix = "") {
  const rows = [];
  for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
    const path = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path, { bigint: true });
    const identity = {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      links: stat.nlink.toString(),
      mode: stat.mode.toString(),
    };
    if (stat.isDirectory()) {
      rows.push({ path: relative, type: "directory", ...identity });
      rows.push(...treeSnapshot(path, relative));
    } else if (stat.isFile()) {
      rows.push({ path: relative, type: "file", bytes: readFileSync(path).toString("base64"), ...identity });
    } else if (stat.isSymbolicLink()) {
      rows.push({ path: relative, type: "symlink", target: readlinkSync(path), ...identity });
    } else {
      assert.fail(`unexpected fixture member: ${relative}`);
    }
  }
  return rows;
}

function controlledActor({ workspace, outside, scratch, parent, displaced, gate, done }) {
  const node = realpathSync(process.execPath);
  const actorCode = `
    const fs = require("node:fs");
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const result = {};
    try {
      fs.writeFileSync(${JSON.stringify(join(outside, "direct-write-must-be-denied.txt"))}, "denied");
      result.directOutsideWrite = "allowed";
    } catch (error) {
      result.directOutsideWrite = error && error.code;
    }
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(gate)})) {
      if (performance.now() >= deadline) throw new Error("actor gate timeout");
      Atomics.wait(sleeper, 0, 0, 5);
    }
    fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(displaced)});
    fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)}, "dir");
    result.replacedAncestor = true;
    fs.writeFileSync(${JSON.stringify(done)}, JSON.stringify(result), { flag: "wx", mode: 0o600 });
  `;
  const command = { kind: "argv", argv: [node, "-e", actorCode] };
  const now = new Date().toISOString();
  const policy = compileExecutionSandboxPolicy({
    now,
    platform: "darwin",
    tool: "bash",
    workspaceRoot: workspace,
    cwd: workspace,
    temporaryRoot: scratch,
    runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, dirname(node)],
    deniedReadRoots: [outside],
    protectedWriteRoots: [],
    backend: readMacosSandboxBackendIdentity(),
    grants: [],
    binding: {
      workspaceId: "controlled-race-workspace",
      runId: "controlled-race-run",
      workUnitId: "controlled-race-unit",
      attemptId: "controlled-race-attempt",
      runtimeInstanceId: "controlled-race-runtime",
      fencingToken: "1",
      toolCallId: "controlled-race-call",
      operationHash: macosSandboxCommandFingerprint(command, workspace, scratch),
    },
    policy: resolveSessionRunPolicy({
      workspacePolicy: createDefaultApprovalPolicy("controlled-race-workspace", now),
      authorizationMode: "always",
      workspaceAccessMode: "workspace_write",
    }).snapshot,
  });
  return prepareMacosSandboxCommand({ policy, command });
}

test("request worker rejects an admitted-parent replacement before any outside write", native, async t => {
  const container = realpathSync(mkdtempSync("/private/tmp/ling-workflow-controlled-race-"));
  const workspace = join(container, "workspace");
  const outside = join(container, "outside");
  const scratch = join(container, "scratch");
  for (const path of [workspace, outside, scratch]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(outside, "keep.txt"), "outside sentinel\n", { flag: "wx", mode: 0o600 });
  const parent = join(workspace, "admitted-parent");
  const displaced = join(workspace, "admitted-parent-original");
  mkdirSync(parent, { mode: 0o700 });
  const gate = join(scratch, "host-before-mkdir.gate");
  const done = join(scratch, "actor-complete.json");
  const targetDirectory = join(parent, "nested");
  const outsideBefore = treeSnapshot(outside);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: workspace }));
  const runtime = supervisor.getExternalWorkflowRequestRuntime();
  assert.ok(runtime, "macOS development Host must provide its fixed request runtime");
  t.after(() => {
    supervisor.releaseAll();
    rmSync(container, { recursive: true, force: true });
  });

  const prepared = controlledActor({ workspace, outside, scratch, parent, displaced, gate, done });
  const child = prepared.spawn(() => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const closed = once(child, "close");

  let actorReceipt;
  const execution = runtime.execute({
    root: workspace,
    workflowPath: "admitted-parent/nested/WORKFLOW.md",
    assertCurrentAuthority() {},
    decide(snapshot) {
      assert.equal(snapshot.path, join(targetDirectory, "WORKFLOW.md"));
      assert.equal(snapshot.exists, false);
      writeFileSync(gate, "continue\n", { flag: "wx", mode: 0o600 });
      waitForPath(done);
      actorReceipt = JSON.parse(readFileSync(done, "utf8"));
      return { action: "replace", markdown: "---\nsource:\n  kind: github\n  repository: fixture/repository\n---\n" };
    },
  });
  await assert.rejects(execution, /workflow_parent_not_directory|workflow_path_changed|operation not permitted/u);

  const [exitCode, signal] = await closed;
  assert.equal(exitCode, 0, stderr || stdout);
  assert.equal(signal, null, stderr || stdout);
  assert.ok(["EPERM", "EACCES"].includes(actorReceipt?.directOutsideWrite), JSON.stringify(actorReceipt));
  assert.equal(actorReceipt?.replacedAncestor, true);
  assert.deepEqual(treeSnapshot(outside), outsideBefore,
    "the request worker must not create anything outside after the ancestor replacement");
});
