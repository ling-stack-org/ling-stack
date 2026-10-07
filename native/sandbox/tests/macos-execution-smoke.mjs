import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, resolveSessionRunPolicy } from "../../../packages/core/dist/index.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity, signalMacosSandboxProcessGroup } from "../../../packages/daemon/dist/runtime/sandbox/macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../../../packages/daemon/dist/runtime/sandbox/macos-seatbelt-profile.js";

assert.equal(process.platform, "darwin", "This is an explicit real-macOS suite, not a mock or Windows check.");
const root = mkdtempSync("/private/tmp/ling-seatbelt-real-");
const workspace = join(root, "workspace");
const scratch = join(root, "scratch");
const outside = join(root, "outside");
for (const path of [workspace, scratch, outside, join(workspace, ".git"), join(workspace, ".ling")]) mkdirSync(path, { mode: 0o700 });
const external = join(outside, "sentinel.txt");
const protectedFile = join(workspace, ".git", "sentinel.txt");
const secret = join(workspace, ".ling", "private.txt");
for (const path of [external, protectedFile, secret]) writeFileSync(path, "KEEP_TEST_SENTINEL", { flag: "wx" });
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const sentinelHash = digest(external);
const node = realpathSync(process.execPath);
let sequence = 0;
function prepare(command, alter = () => {}) {
  const now = new Date().toISOString();
  const input = {
    now, platform: "darwin", tool: "bash", workspaceRoot: workspace, cwd: workspace, temporaryRoot: scratch,
    runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, dirname(node)], deniedReadRoots: [outside], protectedWriteRoots: [],
    backend: readMacosSandboxBackendIdentity(), grants: [],
    binding: { workspaceId: "native-smoke", runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "fixture",
      fencingToken: "1", toolCallId: `tool-${++sequence}`, operationHash: macosSandboxCommandFingerprint(command, workspace, scratch) },
    policy: resolveSessionRunPolicy({ workspacePolicy: createDefaultApprovalPolicy("native-smoke", now), authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot,
  };
  alter(input);
  return prepareMacosSandboxCommand({ policy: compileExecutionSandboxPolicy(input), command });
}
function execute(prepared) {
  return new Promise((resolve, reject) => {
    const child = prepared.spawn(() => {}); // Fixture authority only; no model or live Host approval involved.
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { signalMacosSandboxProcessGroup(child, "SIGKILL"); } catch {} reject(new Error("native smoke timeout")); }, 8000);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
const shell = command => ({ kind: "shell", command, shell: "bash" });
const js = code => ({ kind: "argv", argv: [node, "-e", code] });

test("real Seatbelt starts a fixed command under deny-default", async () => {
  const result = await execute(prepare({ kind: "argv", argv: ["/bin/echo", "ling-native-ok"] }));
  assert.deepEqual(result, { code: 0, signal: null, stdout: "ling-native-ok\n", stderr: "" });
});
test("real command writes and reads its workspace", async () => {
  const result = await execute(prepare(shell("printf 'workspace-ok' > result.txt; /bin/cat result.txt")));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "workspace-ok");
  assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "workspace-ok");
});
test("real command cannot overwrite an outside sentinel", async () => {
  const result = await execute(prepare(shell(`printf bad > '${external}'`)));
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null, "A launch crash is not an OS write denial.");
  assert.match(result.stderr, /not permitted|denied/i);
  assert.equal(digest(external), sentinelHash);
});
test("protected Git metadata remains unwritable", async () => {
  const result = await execute(prepare(shell(`printf bad > '${protectedFile}'`)));
  assert.notEqual(result.code, 0);
  assert.equal(readFileSync(protectedFile, "utf8"), "KEEP_TEST_SENTINEL");
});
test("Ling private state remains unreadable", async () => {
  const result = await execute(prepare({ kind: "argv", argv: ["/bin/cat", secret] }));
  assert.notEqual(result.code, 0);
  assert.ok(!result.stdout.includes("KEEP_TEST_SENTINEL"));
});
test("Node can execute real file operations inside its policy", async () => {
  const result = await execute(prepare(js("require('node:fs').writeFileSync('node.txt','node-ok');console.log(require('node:fs').readFileSync('node.txt','utf8'))")));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "node-ok");
});
test("one prepared invocation cannot be launched twice", async () => {
  const prepared = prepare({ kind: "argv", argv: ["/bin/echo", "once"] });
  assert.equal((await execute(prepared)).code, 0);
  assert.throws(() => prepared.spawn(() => {}), /macos_launch_already_consumed/);
  assert.equal(prepared.descendantStopProof, "not_available");
});
test("a stale current-authority check stops before spawning", () => {
  const prepared = prepare({ kind: "argv", argv: ["/bin/echo", "must-not-run"] });
  assert.throws(() => prepared.spawn(() => { throw new Error("fixture_stale_fence"); }), /fixture_stale_fence/);
  assert.throws(() => prepared.spawn(() => {}), /macos_launch_already_consumed/);
});
test("asynchronous authority checks are not accepted as permission", () => {
  const prepared = prepare({ kind: "argv", argv: ["/bin/echo", "must-not-run"] });
  assert.throws(() => prepared.spawn(async () => {}), /macos_authority_check_must_be_synchronous/);
});
test("shell and Node inherit only the isolated environment", async () => {
  const result = await execute(prepare(js("console.log(Object.keys(process.env).sort().join('|'));console.log(process.env.HOME)")));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["HOME|LANG|LING_STACK_SANDBOX|PATH|PWD|TMPDIR", scratch]);
});
test("symbolic links do not let a command write outside the workspace", async () => {
  symlinkSync(outside, join(workspace, "escape-link"));
  const result = await execute(prepare(shell("printf bad > escape-link/sentinel.txt")));
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(digest(external), sentinelHash);
});
test("an in-sandbox hardlink attempt cannot make an external file writable", async () => {
  const result = await execute(prepare(js(`const fs=require('node:fs');try{fs.linkSync(${JSON.stringify(external)},'hardlink.txt');fs.writeFileSync('hardlink.txt','bad');console.log('ESCAPED')}catch(e){console.log(e.code);process.exitCode=7}`)));
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, /EPERM|EACCES/);
  assert.equal(digest(external), sentinelHash);
});
test("directory replacement between preparation and spawn is rejected", () => {
  const directory = join(root, "replaceable");
  mkdirSync(directory, { mode: 0o700 });
  const prepared = prepare({ kind: "argv", argv: ["/bin/echo", "must-not-run"] }, input => { input.runtimeReadRoots.push(directory); });
  renameSync(directory, directory + "-original");
  mkdirSync(directory, { mode: 0o700 });
  assert.throws(() => prepared.spawn(() => {}), /macos_path_identity_changed/);
});
test("a changed command cannot borrow the prepared operation fingerprint", () => {
  assert.throws(() => prepare({ kind: "argv", argv: ["/bin/echo", "changed"] }, input => { input.binding.operationHash = "f".repeat(64); }), /macos_command_binding_mismatch/);
});
test("later argument mutation cannot change the actual launched command", async () => {
  const command = { kind: "argv", argv: ["/bin/echo", "original"] };
  const prepared = prepare(command);
  command.argv[1] = "changed";
  assert.equal((await execute(prepared)).stdout, "original\n");
});
test("real TCP is denied, allowed for one bound call, then denied again", async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end("fixture-response"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const command = js(`const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${port}});s.setTimeout(1500,()=>{console.log('timeout');s.destroy();process.exitCode=8});s.on('data',d=>console.log(d.toString()));s.on('error',e=>{console.log('denied:'+e.code);process.exitCode=7})`);
  try {
    const denied = await execute(prepare(command));
    assert.equal(denied.code, 7, denied.stderr);
    assert.match(denied.stdout, /denied:EPERM|denied:EACCES/);
    assert.equal(connections, 0);
    const allowed = await execute(prepare(command, input => { input.grants = [{ id: "network-once", approvalId: "fixture-approval", binding: { ...input.binding }, cwd: workspace,
      scope: { kind: "command_network" }, status: "approved", createdAt: input.now, expiresAt: new Date(Date.now() + 60_000).toISOString() }]; }));
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), "fixture-response");
    assert.equal(connections, 1);
    assert.equal((await execute(prepare(command))).code, 7);
    assert.equal(connections, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("group cancellation reaches a normal child but does not claim escaped-descendant proof", async () => {
  // Both fixture processes expire independently even if the assertion or cancellation fails.
  const code = "const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),8000)'],{stdio:'inherit'});console.log('CHILD='+c.pid);setTimeout(()=>process.exit(0),10000)";
  const prepared = prepare(js(code));
  const child = prepared.spawn(() => {});
  let childPid;
  const closed = once(child, "close");
  let timer;
  let onData;
  const bounded = async promise => {
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("process fixture deadline exceeded")), 4000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const started = new Promise(resolve => {
      let output = "";
      onData = chunk => {
        output += chunk;
        const match = /CHILD=(\d+)\n/.exec(output);
        if (match) resolve(Number(match[1]));
      };
      child.stdout.on("data", onData);
    });
    childPid = await bounded(Promise.race([started, closed.then(() => { throw new Error("process closed before reporting its child"); })]));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
    assert.equal(signalMacosSandboxProcessGroup(child, "SIGTERM"), true);
    const [code, signal] = await bounded(closed);
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    for (let index = 0; index < 40; index++) {
      try { process.kill(childPid, 0); } catch (error) { if (error.code === "ESRCH") { childPid = undefined; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(childPid, undefined, "Normal child must be gone before this test passes.");
    assert.equal(prepared.descendantStopProof, "not_available");
    assert.throws(() => signalMacosSandboxProcessGroup(child, "SIGKILL"), /macos_process_group_not_owned/);
  } finally {
    clearTimeout(timer);
    if (onData) child.stdout.off("data", onData);
    try { signalMacosSandboxProcessGroup(child, "SIGKILL"); } catch {}
  }
});
test.after(() => { process.stdout.write(`NATIVE_SMOKE_FIXTURE=${root}\n`); });
