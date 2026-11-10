import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, linkSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { test } from "node:test";
import { captureNativeCommandInput } from "../../../packages/daemon/dist/runtime/sandbox/native-input-capture.js";
import { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, resolveSessionRunPolicy } from "../../../packages/core/dist/index.js";
import { prepareMacosSandboxCommand, readMacosSandboxBackendIdentity, macosSandboxCommandFingerprint } from "../../../packages/daemon/dist/runtime/sandbox/macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "../../../packages/daemon/dist/runtime/sandbox/macos-seatbelt-profile.js";
const executable = process.argv[2];
assert.ok(executable && isAbsolute(executable)); assert.equal(process.platform, "darwin");
const root = realpathSync(mkdtempSync("/private/tmp/ling-native-input-host-"));
const origin = join(root, "origin"), copy = join(root, "copy"), scratch = join(root, "scratch");
for (const directory of [origin, copy, scratch]) mkdirSync(directory, { mode: 0o700 });
mkdirSync(join(origin, "src")); mkdirSync(join(copy, "src"));
writeFileSync(join(origin, "src", "proof.mjs"), "export const formatProof = value => 'proof:' + value;\n");
const identity = { workspaceId: "fixture", runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "1" };
const helper = { path: executable, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), version: "0.1.0-dev.0" };
const options = () => ({ helper, root: origin, path: "src/proof.mjs", maxBytes: 1024 * 1024, identity, assertCurrentAuthority() {} });
test("real Host consumer accepts verified native bytes and digest after its final owner check", async () => {
  let checks = 0;
  const result = await captureNativeCommandInput({ ...options(), assertCurrentAuthority() { checks++; } });
  assert.equal(checks, 3); assert.deepEqual(result.bytes, readFileSync(join(origin, "src", "proof.mjs")));
  assert.equal(result.sha256, createHash("sha256").update(result.bytes).digest("hex"));
});
test("owner replacement, cancellation and helper hash mismatch never publish an input", async () => {
  let checks = 0;
  await assert.rejects(captureNativeCommandInput({ ...options(), assertCurrentAuthority() {
    if (++checks === 3) throw new Error("fixture-owner-replaced");
  } }), /fixture-owner-replaced/);
  const controller = new AbortController();
  const pending = captureNativeCommandInput({ ...options(), signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /native_input_cancelled/);
  await assert.rejects(captureNativeCommandInput({ ...options(), helper: { ...helper, sha256: "0".repeat(64) } }), /native_input_helper_identity_invalid/);
});
test("native capture feeds a real isolated Node invocation without exposing the origin workspace", async () => {
  const captured = await captureNativeCommandInput(options());
  const target = join(copy, "src", "proof.mjs"); writeFileSync(target, captured.bytes, { flag: "wx", mode: 0o600 });
  assert.notEqual(statSync(target).ino, statSync(join(origin, "src", "proof.mjs")).ino);
  const node = realpathSync(process.execPath), now = new Date().toISOString();
  const command = { kind: "argv", argv: [node, "--input-type=module", "-e",
    `import {formatProof} from './src/proof.mjs';import fs from 'node:fs';console.log(formatProof('7319'));try{fs.readFileSync(${JSON.stringify(join(origin, "src", "proof.mjs"))});process.exitCode=9}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('origin:denied')}`] };
  const effective = resolveSessionRunPolicy({ workspacePolicy: createDefaultApprovalPolicy("fixture", now), authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const policy = compileExecutionSandboxPolicy({ now, platform: "darwin", tool: "bash", workspaceRoot: copy, cwd: copy, temporaryRoot: scratch,
    runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, dirname(node)], deniedReadRoots: [origin], protectedWriteRoots: [], backend: readMacosSandboxBackendIdentity(), grants: [],
    policy: { ...effective, allowedWritePaths: [] }, binding: { ...identity, toolCallId: "command", operationHash: macosSandboxCommandFingerprint(command, copy, scratch) } });
  const result = await new Promise((resolve, reject) => {
    const child = prepareMacosSandboxCommand({ policy, command }).spawn(() => {});
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("isolated Node timeout")); }, 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: "proof:7319\norigin:denied\n", stderr: "" });
  assert.deepEqual(readFileSync(join(origin, "src", "proof.mjs")), captured.bytes);
});
test("real consumer refuses a pre-existing hardlink rather than copying protected bytes", async () => {
  const secret = join(root, "secret"); writeFileSync(secret, "private-fixture"); linkSync(secret, join(origin, "alias"));
  await assert.rejects(captureNativeCommandInput({ ...options(), path: "alias" }), /native_input_helper_input_hardlink_rejected/);
  assert.equal(readFileSync(secret, "utf8"), "private-fixture");
});
test("UTF-8 names and quoted path characters survive the real strict wire decoder", async () => {
  const path = '中文 input "quoted".txt'; writeFileSync(join(origin, path), "内容😀\n");
  const result = await captureNativeCommandInput({ ...options(), path });
  assert.equal(result.bytes.toString("utf8"), "内容😀\n");
});
test.after(() => process.stdout.write(`NATIVE_HOST_INPUT_FIXTURE=${root}\n`));
