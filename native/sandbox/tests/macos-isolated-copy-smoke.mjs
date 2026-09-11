/**
 * Explicit macOS T2-B experiment. Temporary fixture data only, no real project.
 * The final descendant test remains a release-blocking assertion, not a skip.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, linkSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, resolveSessionRunPolicy } from "../../../packages/core/dist/index.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity, signalMacosSandboxProcessGroup } from "../../../packages/daemon/dist/runtime/sandbox/macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../../../packages/daemon/dist/runtime/sandbox/macos-seatbelt-profile.js";
import { captureIsolatedCopy, createIsolatedCopyFixture, proposeIsolatedChanges } from "../prototypes/isolated-copy.mjs";

assert.equal(process.platform, "darwin", "Explicit macOS experiment, not mocked platform acceptance.");
const node = realpathSync(process.execPath);
const fixtures = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = () => {
  const value = createIsolatedCopyFixture();
  fixtures.push(value.root);
  return value;
};
function prepare(value, code) {
  const command = { kind: "argv", argv: [node, "-e", code] };
  const now = new Date().toISOString();
  const policy = compileExecutionSandboxPolicy({
    now, platform: "darwin", tool: "bash", workspaceRoot: value.execution, cwd: value.execution, temporaryRoot: value.scratch,
    runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, dirname(node)],
    deniedReadRoots: [value.origin, value.outside, join(value.root, "host-staging")],
    protectedWriteRoots: [value.origin, value.outside, join(value.root, "host-staging")],
    backend: readMacosSandboxBackendIdentity(), grants: [],
    binding: { workspaceId: "copy-fixture", runId: "run", workUnitId: "unit", attemptId: "attempt",
      runtimeInstanceId: "fixture", fencingToken: "1", toolCallId: "copy-probe",
      operationHash: macosSandboxCommandFingerprint(command, value.execution, value.scratch) },
    policy: resolveSessionRunPolicy({ workspacePolicy: createDefaultApprovalPolicy("copy-fixture", now),
      authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot,
  });
  return prepareMacosSandboxCommand({ policy, command });
}
function observe(prepared) {
  const child = prepared.spawn(() => {}); // Explicit fixture authority, never real Host permission.
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = once(child, "close");
  const timeout = setTimeout(() => {
    try { signalMacosSandboxProcessGroup(child, "SIGKILL"); } catch {}
  }, 6000);
  const result = closed.then(([code, signal]) => ({ code, signal, stdout, stderr })).finally(() => clearTimeout(timeout));
  return { child, result, output: () => stdout };
}

test("copy-backed real command changes its file without mutating the external hardlink or source", async () => {
  const value = fixture();
  writeFileSync(join(value.outside, "sentinel"), "external-original");
  linkSync(join(value.outside, "sentinel"), join(value.origin, "linked.txt"));
  captureIsolatedCopy(value);
  const result = await observe(prepare(value, "require('node:fs').writeFileSync('linked.txt','agent-output');console.log('copied-write-ok')")).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "copied-write-ok");
  assert.equal(readFileSync(join(value.outside, "sentinel"), "utf8"), "external-original");
  assert.equal(readFileSync(join(value.origin, "linked.txt"), "utf8"), "external-original");
  assert.equal(readFileSync(join(value.execution, "linked.txt"), "utf8"), "agent-output");
  assert.equal(proposeIsolatedChanges(value).changes[0].kind, "replace");
});

test("real command cannot write back directly to the source or Host staging", async () => {
  const value = fixture();
  writeFileSync(join(value.origin, "app.js"), "source-original");
  captureIsolatedCopy(value);
  const targets = [join(value.origin, "app.js"), join(value.root, "host-staging", "injected")];
  const result = await observe(prepare(value, "const fs=require('node:fs');for(const path of " + JSON.stringify(targets)
    + "){try{fs.writeFileSync(path,'bad');console.log('ALLOWED')}catch(e){console.log(e.code)}}")).result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /EPERM|EACCES/);
  assert.ok(!result.stdout.includes("ALLOWED"));
  assert.equal(readFileSync(join(value.origin, "app.js"), "utf8"), "source-original");
});

test("a small copied Node project supports child execution, imports and a generated result", async () => {
  const value = fixture();
  mkdirSync(join(value.origin, "lib"));
  writeFileSync(join(value.origin, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(join(value.origin, "lib", "proof.js"), "exports.formatProof = value => value + ':verified';\n");
  writeFileSync(join(value.origin, "app.js"),
    "const {formatProof}=require('./lib/proof.js');const result=formatProof('7319');require('node:fs').writeFileSync('result.txt',result);console.log(result);\n");
  captureIsolatedCopy(value);
  const result = await observe(prepare(value, "const cp=require('node:child_process');const result=cp.spawnSync(process.execPath,['app.js'],{encoding:'utf8'});if(result.error)throw result.error;process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status")).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "7319:verified");
  assert.equal(readFileSync(join(value.execution, "result.txt"), "utf8"), "7319:verified");
  const proposal = proposeIsolatedChanges(value);
  assert.deepEqual(proposal.changes.map(change => [change.path, change.kind]), [["result.txt", "create"]]);
  // This evidence is a generated file in the execution copy, not a published artifact.
  assert.throws(() => readFileSync(join(value.origin, "result.txt")), { code: "ENOENT" });
});

test("required boundary: detached descendants stop before a copy-backed run may be considered quiescent", async () => {
  const value = fixture();
  captureIsolatedCopy(value);
  const detachedCode = "const fs=require('node:fs');let n=0;fs.writeFileSync('heartbeat.txt','0');process.stdout.write('READY\\n');const timer=setInterval(()=>fs.writeFileSync('heartbeat.txt',String(++n)),20);setTimeout(()=>{clearInterval(timer);process.exit(0)},1800)";
  const parentCode = "const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',"
    + JSON.stringify(detachedCode) + "],{detached:true,stdio:['ignore','pipe','ignore']});"
    + "c.on('error',e=>{console.log('ERROR:'+e.code);process.exitCode=7});"
    + "c.stdout.once('data',()=>console.log('CHILD='+c.pid));c.unref();setTimeout(()=>process.exit(0),4000)";
  const prepared = prepare(value, parentCode);
  const running = observe(prepared);
  let pid;
  for (let n = 0; n < 100; n++) {
    const match = /CHILD=(\d+)/.exec(running.output());
    if (match) { pid = Number(match[1]); break; }
    if (running.child.exitCode !== null || running.child.signalCode !== null) break;
    await pause(20);
  }
  if (!pid) {
    try { signalMacosSandboxProcessGroup(running.child, "SIGKILL"); } catch {}
    const result = await running.result;
    assert.fail("fixture did not create an observed detached child: " + JSON.stringify(result));
  }
  assert.equal(signalMacosSandboxProcessGroup(running.child, "SIGTERM"), true);
  const result = await running.result;
  assert.equal(result.signal, "SIGTERM");
  const heartbeat = join(value.execution, "heartbeat.txt");
  const before = readFileSync(heartbeat, "utf8");
  await pause(160);
  const after = readFileSync(heartbeat, "utf8");
  const continuedWriting = after !== before;
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const survived = alive();
  // All descendants are finite test programs; wait for their own cleanup rather
  // than signalling a possibly recycled PID after the leader has been reaped.
  for (let n = 0; n < 120 && alive(); n++) await pause(25);
  const evidence = { case: "copy_detached_descendant", survivedGroupCancellation: survived,
    continuedWritingAfterLeaderExit: continuedWriting, selfExpired: !alive(),
    declaredProof: prepared.descendantStopProof, productionPublicationAllowed: false, fixture: value.root };
  console.log(JSON.stringify(evidence));
  assert.equal(evidence.selfExpired, true, "The temporary descendant must self-expire.");
  assert.equal(survived || continuedWriting, false, "Copying files does not establish complete descendant quiescence.");
});
test.after(() => console.log(JSON.stringify({ fixtures, productExecutionWired: false, realProjectModified: false })));
