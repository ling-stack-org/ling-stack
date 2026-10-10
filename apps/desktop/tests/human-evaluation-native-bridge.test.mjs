import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHumanEvaluationNativeBridge, invokeHumanEvaluationHelper, parseHumanNativeSession,
  resolveHumanEvaluationHelper } from "../dist/main/human-evaluation/native-bridge.js";

const session = { osSessionId: "a".repeat(64), osUserId: "b".repeat(64), active: true, locked: false };
const payloadJson = JSON.stringify({ taskId: "qa-one", submission: { kind: "revoke", rationale: "test" } });
const input = { intentId: "intent-one", requestId: "request-one", payloadJson,
  payloadDigest: createHash("sha256").update(payloadJson).digest("hex"), signal: new AbortController().signal };

test("Swift source contract admits the Main 160-char ID range and bounds stdin before materialization (not OS UI acceptance)", () => {
  const source = readFileSync(new URL("../scripts/native/human-evaluation-darwin.swift", import.meta.url), "utf8");
  assert.match(source, /requestId\.count <= 160/u);
  assert.match(source, /readData\(ofLength: min\(4096, 32769 - bytes\.count\)\)/u);
  assert.doesNotMatch(source, /readDataToEndOfFile/u);
});

test("native confirmation binds every intent and a unique invocation, never a shared success", async () => {
  const calls = [];
  const bridge = createHumanEvaluationNativeBridge({ helperPath: "/fixed/helper", async invoke(_path, request) {
    calls.push(request);
    return request.command === "session" ? session : { status: "confirmed", invocationId: request.invocationId,
      intentId: request.intentId, requestId: request.requestId, payloadDigest: request.payloadDigest,
      sessionBefore: session, sessionAfter: session };
  } });
  assert.deepEqual(await bridge.readSession(input.signal), session);
  assert.equal((await bridge.confirm(input)).status, "confirmed");
  await bridge.confirm({ ...input, requestId: "request-two" });
  assert.notEqual(calls[1].invocationId, calls[2].invocationId);
  assert.equal(calls[1].payloadJson, payloadJson);
});

for (const mutation of ["invocationId", "intentId", "requestId", "payloadDigest", "extra", "session"]) {
  test(`native ${mutation} confusion fails closed`, async () => {
    const bridge = createHumanEvaluationNativeBridge({ helperPath: "/fixed/helper", async invoke(_path, request) {
      const value = { status: "confirmed", invocationId: request.invocationId, intentId: request.intentId,
        requestId: request.requestId, payloadDigest: request.payloadDigest, sessionBefore: session, sessionAfter: session };
      if (mutation === "extra") value.authenticated = true;
      else if (mutation === "session") value.sessionAfter = { ...session, authenticated: true };
      else value[mutation] = "wrong";
      return value;
    } });
    await assert.rejects(bridge.confirm(input), /confirmation_invalid/);
  });
}

test("digest mismatch and oversized native payload do not spawn", async () => {
  let calls = 0;
  const bridge = createHumanEvaluationNativeBridge({ helperPath: "/fixed/helper", invoke() { calls++; } });
  await assert.rejects(bridge.confirm({ ...input, payloadJson: "different" }), /payload_invalid/);
  await assert.rejects(bridge.confirm({ ...input, payloadJson: "x".repeat(25_000) }), /payload_invalid/);
  assert.equal(calls, 0);
  assert.equal(parseHumanNativeSession({ ...session, secret: "forged" }), undefined);
});

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}
for (const trigger of ["abort", "timeout", "overflow", "spawn_error", "stdin_error"]) {
  test(`native ${trigger} does not release until actual child close (controlled process fixture)`, async () => {
    const child = childFixture(), controller = new AbortController();
    let settled = false;
    const promise = invokeHumanEvaluationHelper("/fixed/helper", {}, controller.signal, () => child,
      trigger === "timeout" ? 1 : 1000).finally(() => { settled = true; });
    const rejected = assert.rejects(promise, /human_native_/);
    if (trigger === "abort") controller.abort();
    if (trigger === "overflow") child.stdout.write(Buffer.alloc(16_385));
    if (trigger === "spawn_error") child.emit("error", new Error("test"));
    if (trigger === "stdin_error") child.stdin.emit("error", new Error("test"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false);
    child.stdout.write(JSON.stringify({ status: "confirmed" }));
    child.emit("close", trigger === "spawn_error" ? -2 : 0);
    await rejected;
    assert.equal(settled, true);
  });
}

test("packaged path rejects non-executable, symlinked helper and symlinked directory", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-human-path-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "human-evaluation"), helper = join(directory, "ling-human-evaluation-helper");
  mkdirSync(directory); writeFileSync(helper, "fixture", { mode: 0o600 });
  assert.throws(() => resolveHumanEvaluationHelper(root, "darwin"));
  chmodSync(helper, 0o700);
  assert.equal(resolveHumanEvaluationHelper(root, "darwin"), helper);
  rmSync(helper); symlinkSync(join(root, "external"), helper);
  assert.throws(() => resolveHumanEvaluationHelper(root, "darwin"));
  rmSync(helper); rmdirSync(directory); mkdirSync(join(root, "external")); symlinkSync(join(root, "external"), directory);
  assert.throws(() => resolveHumanEvaluationHelper(root, "darwin"));
  assert.throws(() => resolveHumanEvaluationHelper(root, "win32"), /unavailable/);
});
