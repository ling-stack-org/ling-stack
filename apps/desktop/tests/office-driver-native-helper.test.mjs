import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OFFICE_DRIVER_MAX_FRAME_BYTES, OFFICE_DRIVER_PROTOCOL } from "@ling-stack/contracts";
import { encodeOfficeDriverFrame, OfficeDriverFrameDecoder } from "../dist/main/office-driver/framing.js";

const supported = process.platform === "darwin" && process.arch === "arm64";
const executablePath = resolve(
  import.meta.dirname,
  "../dist/office-driver/darwin-arm64/OfficeDriver.app/Contents/MacOS/ling-office-driver",
);

test("signed macOS Office helper reports local availability and rejects unknown request fields", { skip: !supported }, async () => {
  const recoveryRoot = await mkdtemp(resolve(tmpdir(), "ling-office-native-"));
  const child = spawn(executablePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LING_OFFICE_PARENT_PID: String(process.pid), LING_OFFICE_RECOVERY_ROOT: recoveryRoot },
  });
  try {
    const responses = collectFrames(child.stdout);
    child.stdin.write(encodeOfficeDriverFrame(request("status", {})));
    const status = await responses.next();
    assert.equal(status.value.ok, true);
    assert.equal(["office_missing", "application_not_running", "permission_required", "limited"].includes(status.value.result.state), true);

    child.stdin.write(encodeOfficeDriverFrame({ ...request("unknown", {}), unexpected: "reject-me" }));
    const rejected = await responses.next();
    assert.equal(rejected.value.ok, false);
    assert.equal(rejected.value.error.code, "office_driver_request_invalid");

    child.stdin.end();
    assert.equal((await exitOf(child)).code, 0);
  } finally {
    child.kill("SIGKILL");
    await rm(recoveryRoot, { recursive: true, force: true });
  }
});

test("macOS Office helper terminates on oversized and truncated frames", { skip: !supported }, async () => {
  const env = { ...process.env, LING_OFFICE_PARENT_PID: String(process.pid), LING_OFFICE_RECOVERY_ROOT: tmpdir() };
  const oversized = spawn(executablePath, [], { stdio: ["pipe", "ignore", "ignore"], env });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(OFFICE_DRIVER_MAX_FRAME_BYTES + 1);
  oversized.stdin.end(header);
  assert.equal((await exitOf(oversized)).signal, null);

  const truncated = spawn(executablePath, [], { stdio: ["pipe", "ignore", "ignore"], env });
  const truncatedHeader = Buffer.alloc(4);
  truncatedHeader.writeUInt32LE(10);
  truncated.stdin.end(Buffer.concat([truncatedHeader, Buffer.from("short")]));
  const truncatedExit = await exitOf(truncated);
  assert.equal(truncatedExit.code === 0, false);
});

test("macOS Office helper exits when its owning Desktop process is gone", { skip: !supported }, async () => {
  const recoveryRoot = await mkdtemp(resolve(tmpdir(), "ling-office-parent-loss-"));
  const parent = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const child = spawn(executablePath, [], {
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      ...process.env,
      LING_OFFICE_PARENT_PID: String(parent.pid),
      LING_OFFICE_RECOVERY_ROOT: recoveryRoot,
    },
  });
  try {
    const parentExit = exitOf(parent);
    const childExit = exitOf(child);
    parent.kill("SIGTERM");
    await parentExit;
    const exited = await Promise.race([
      childExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("office_driver_parent_loss_timeout")), 3_000)),
    ]);
    assert.equal(exited.signal, null);
  } finally {
    parent.kill("SIGKILL");
    child.kill("SIGKILL");
    await rm(recoveryRoot, { recursive: true, force: true });
  }
});

function request(id, params) {
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    id,
    method: "driver_status",
    params,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    idempotencyKey: `test:${id}`,
  };
}

async function* collectFrames(stream) {
  const decoder = new OfficeDriverFrameDecoder();
  for await (const chunk of stream) {
    for (const value of decoder.push(chunk)) yield value;
  }
  decoder.finish();
}

function exitOf(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
