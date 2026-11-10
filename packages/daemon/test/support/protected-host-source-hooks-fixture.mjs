import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileExecutionSandboxPolicy, createSqliteRunStore, DEFAULT_WORKSPACE_ID,
  resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { observeSourceHookBootstrap } from "./protected-host-source-bootstrap-observer.mjs";

const dist = process.env.LING_PROTECTED_HOST_SOURCE_TEST_DIST
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
export const loadSourceHookModule = path => import(pathToFileURL(join(dist, path)).href);

/** Real source ownership/Store fixture; dyld and spawn observers are not OS/FD/descendant proof. */
export async function createSourceHookFixture(t) {
  const macos = await loadSourceHookModule("runtime/sandbox/macos-native-command.js");
  const { ProtectedHostStageRegistry } = await loadSourceHookModule("runtime/sandbox/protected-host-staging.js");
  const { MACOS_SYSTEM_READ_ROOTS } = await loadSourceHookModule("runtime/sandbox/macos-seatbelt-profile.js");
  observeSourceHookBootstrap(t);
  const root = realpathSync(mkdtempSync("/private/tmp/ling-source-hooks-")), cwd = join(root, "workspace");
  const stagePath = join(root, "stage");
  for (const path of [cwd, stagePath]) mkdirSync(path, { mode: 0o700 });
  const store = createSqliteRunStore(cwd), registry = new ProtectedHostStageRegistry(), arenas = [], stages = [];
  const now = new Date().toISOString(), id = "source-hooks-run";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "source-hooks-runtime",
    runnerId: "pi", status: "started", now });
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always",
    workspaceAccessMode: "workspace_write" }).snapshot;
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: "source-hooks-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot: policy }, createdAt: now });
  store.linkRunToWorkUnit(id, unit.id, now); store.markRunStarted(id, now);
  const run = store.getRun(id), sourceFence = toRuntimeAttemptFence(attempt);
  const register = () => {
    const stage = registry.registerStage({ store, run, sourceFence, stagePath }); stages.push(stage); return stage;
  };
  const prepared = () => {
    const command = { kind: "argv", argv: ["/usr/bin/true"] }, toolCallId = "source-hooks-call";
    const arena = realpathSync(mkdtempSync("/private/tmp/ling-command-")); arenas.push(arena);
    const copy = join(arena, "workspace"), scratch = join(arena, "scratch");
    for (const path of [copy, scratch]) mkdirSync(path, { mode: 0o700 });
    const source = registry.captureActorSource({ store, run, sourceFence, command: "true", toolCallId });
    const protectedRoots = registry.protectedRoots(source);
    const commandPolicy = compileExecutionSandboxPolicy({ now, platform: "darwin", tool: "bash", workspaceRoot: copy,
      cwd: copy, temporaryRoot: scratch, runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS], deniedReadRoots: [cwd, ...protectedRoots],
      protectedWriteRoots: protectedRoots, backend: macos.readMacosSandboxBackendIdentity(), grants: [],
      policy: { ...policy, allowedWritePaths: [] }, binding: { ...sourceFence, workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id,
        toolCallId, operationHash: macos.macosSandboxCommandFingerprint(command, copy, scratch) } });
    return { source, prepared: macos.prepareMacosSandboxCommand({ policy: commandPolicy, command }) };
  };
  const helperPath = realpathSync("/usr/bin/true");
  const input = { helper: { path: helperPath, sha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex"),
    version: "source-hooks-fixture" }, root: cwd, path: "input", maxBytes: 3,
    identity: { ...sourceFence, workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id }, assertCurrentAuthority() {} };
  t.after(() => {
    for (const stage of stages) registry.closeStage(stage);
    store.close();
    for (const arena of arenas) rmSync(arena, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { registry, store, run, sourceFence, cwd, stagePath, register, prepared, input };
}

/** Preserve native call arguments without starting an OS process or implying descendant closure. */
export function observeSourceSpawns(t) {
  const calls = [], children = [];
  const patch = t.mock.method(childProcess, "spawn", (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    Object.assign(child, { pid: 55000 + calls.length, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      unref() {}, kill() { return true; } });
    const requestBytes = [];
    child.stdin.on("data", bytes => requestBytes.push(bytes));
    child.stdin.once("finish", () => {
      if (args[1]?.[0] === "--read-input") {
        const wire = Buffer.concat(requestBytes), request = JSON.parse(wire.subarray(4).toString("utf8"));
        const start = { type: "input_started", ...request.handshake };
        delete start.operation; delete start.expectedHelperVersion; delete start.parentPid;
        const stat = lstatSync(args[0]);
        const finish = { type: "input_completed", rootDevice: request.rootDevice, rootInode: request.rootInode,
          path: request.path, sizeBytes: 3, metadata: { device: String(stat.dev), inode: String(stat.ino), links: "1",
            sizeBytes: 3, mode: 0o100600, modifiedSec: "1", modifiedNsec: "0", changedSec: "1", changedNsec: "0" } };
        child.stdout.write(Buffer.concat([start, { type: "input_chunk", index: 0, hex: "616263" }, finish].map(frame)));
      }
      child.exitCode = 0;
      child.stdout.end(); child.stderr.end();
      child.emit("exit", 0, null); child.emit("close", 0, null);
    });
    queueMicrotask(() => child.emit("spawn"));
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  return { calls, children };
}
function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}
