import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import test from "node:test";
import { EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE } from "../dist/runtime/sandbox/external-workflow-request-worker-source.js";

function worker(t) {
  const child = spawn(process.execPath, ["--eval", EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE], {
    stdio: "pipe",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return {
    child,
    async next() {
      const row = await lines.next();
      assert.equal(row.done, false, stderr || "worker stdout closed before a frame");
      return JSON.parse(row.value);
    },
    async close() {
      const [code, signal] = await closed;
      return { code, signal, stderr };
    },
  };
}

function partialWriteWorker(t, target, report) {
  const bootstrap = String.raw`
    const fs = require("node:fs");
    const [target, report, encodedSource] = process.argv.slice(1);
    const original = {
      openSync: fs.openSync.bind(fs),
      writeSync: fs.writeSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
      writeFileSync: fs.writeFileSync.bind(fs),
    };
    let targetFd;
    let writes = 0;
    let closes = 0;
    fs.openSync = (path, flags, ...rest) => {
      const fd = original.openSync(path, flags, ...rest);
      if (path === target && typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) targetFd = fd;
      return fd;
    };
    fs.writeSync = (fd, bytes, offset, length, position) => {
      if (fd === targetFd) {
        writes += 1;
        if (writes === 1) return original.writeSync(fd, bytes, offset, Math.min(length, 3), position);
        const error = new Error("fixture partial write EIO");
        error.code = "EIO";
        throw error;
      }
      return original.writeSync(fd, bytes, offset, length, position);
    };
    fs.closeSync = fd => {
      if (fd === targetFd) closes += 1;
      return original.closeSync(fd);
    };
    process.once("exit", () => {
      targetFd = undefined;
      original.writeFileSync(report, JSON.stringify({ writes, closes }), { flag: "wx", mode: 0o600 });
    });
    new Function("require", "process", "Buffer", Buffer.from(encodedSource, "base64").toString("utf8"))
      (require, process, Buffer);
  `;
  const child = spawn(process.execPath, ["--eval", bootstrap, target, report,
    Buffer.from(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE, "utf8").toString("base64")], {
    stdio: "pipe",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return {
    child,
    async next() {
      const row = await lines.next();
      assert.equal(row.done, false, stderr || "worker stdout closed before a frame");
      return JSON.parse(row.value);
    },
    async close() {
      const [code, signal] = await closed;
      return { code, signal, stderr };
    },
  };
}

function fixture(t) {
  const container = realpathSync(mkdtempSync("/private/tmp/ling-external-worker-protocol-"));
  const root = join(container, "workspace");
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(container, { recursive: true, force: true }));
  return { container, root };
}

function send(child, frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

test("fixed request worker opens snapshots read-only and never uses truncating open", () => {
  assert.match(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE, /O_RDONLY \| O_NOFOLLOW/u);
  assert.match(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE, /O_RDWR \| O_NOFOLLOW/u);
  assert.match(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE, /O_CREAT \| fs\.constants\.O_EXCL/u);
  assert.doesNotMatch(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE, /O_TRUNC/u);
});

test("fixed request worker rejects malformed and over-budget input frames", async t => {
  const malformed = worker(t);
  malformed.child.stdin.end("{not-json}\n");
  const malformedFrame = await malformed.next();
  assert.equal(malformedFrame.type, "error");
  assert.equal((await malformed.close()).code, 1);

  const oversized = worker(t);
  oversized.child.stdin.end("x".repeat(2 * 1024 * 1024 + 1));
  const oversizedFrame = await oversized.next();
  assert.deepEqual({ type: oversizedFrame.type, code: oversizedFrame.code },
    { type: "error", code: "workflow_frame_budget_exceeded" });
  assert.equal((await oversized.close()).code, 1);
});

test("fixed request worker reports a broken decision stream and never creates the target", async t => {
  const f = fixture(t);
  const run = worker(t);
  send(run.child, { type: "init", protocolVersion: 1, root: f.root, workflowPath: "WORKFLOW.md" });
  const snapshot = await run.next();
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.exists, false);
  run.child.stdin.end();
  const error = await run.next();
  assert.deepEqual({ type: error.type, code: error.code },
    { type: "error", code: "workflow_request_incomplete" });
  assert.equal((await run.close()).code, 1);
  assert.equal(existsSync(join(f.root, "WORKFLOW.md")), false);
});

test("fixed request worker rejects a stale decision token without replay", async t => {
  const f = fixture(t);
  const run = worker(t);
  send(run.child, { type: "init", protocolVersion: 1, root: f.root, workflowPath: "WORKFLOW.md" });
  const snapshot = await run.next();
  assert.equal(snapshot.type, "snapshot");
  send(run.child, { type: "decision", protocolVersion: 1, token: "0".repeat(64), action: "replace",
    markdownBase64: Buffer.from("must not write", "utf8").toString("base64") });
  run.child.stdin.end();
  const error = await run.next();
  assert.deepEqual({ type: error.type, code: error.code },
    { type: "error", code: "workflow_decision_invalid" });
  assert.equal((await run.close()).code, 1);
  assert.equal(existsSync(join(f.root, "WORKFLOW.md")), false);
});

test("fixed request worker bounds source file bytes before emitting a snapshot", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "WORKFLOW.md"), Buffer.alloc(1024 * 1024 + 1, 0x61), { flag: "wx", mode: 0o600 });
  const run = worker(t);
  send(run.child, { type: "init", protocolVersion: 1, root: f.root, workflowPath: null });
  run.child.stdin.end();
  const error = await run.next();
  assert.deepEqual({ type: error.type, code: error.code },
    { type: "error", code: "workflow_file_budget_exceeded" });
  assert.equal((await run.close()).code, 1);
});

test("fixed request worker closes a partially written owned file and never replays the failed write", async t => {
  const f = fixture(t);
  const target = join(f.root, "partial.md");
  const report = join(f.container, "partial-write-report.json");
  const run = partialWriteWorker(t, target, report);
  send(run.child, { type: "init", protocolVersion: 1, root: f.root, workflowPath: "partial.md" });
  const snapshot = await run.next();
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.exists, false);
  send(run.child, { type: "decision", protocolVersion: 1, token: snapshot.token, action: "replace",
    markdownBase64: Buffer.from("---\nsource:\n  kind: github\n---\n", "utf8").toString("base64") });
  run.child.stdin.end();
  const error = await run.next();
  assert.deepEqual({ type: error.type, code: error.code },
    { type: "error", code: "fixture partial write EIO" });
  const closed = await run.close();
  assert.equal(closed.code, 1, closed.stderr);
  assert.equal(closed.signal, null, closed.stderr);
  assert.equal(readFileSync(target, "utf8"), "---");
  assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { writes: 2, closes: 1 });
});
