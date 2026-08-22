import assert from "node:assert/strict";
import test from "node:test";
import { OFFICE_DRIVER_PROTOCOL } from "@ling-stack/contracts";
import {
  normalizeHelperResult,
  OfficeDriverRuntime,
  resolveOfficeDriverExecutablePath,
  toHelperCommand,
} from "../dist/main/office-driver/runtime.js";
import { encodeOfficeDriverFrame, OfficeDriverFrameDecoder } from "../dist/main/office-driver/framing.js";

test("Office driver framing handles split and coalesced little-endian frames", () => {
  const first = encodeOfficeDriverFrame({ id: "one", value: "a".repeat(20) }, 64);
  const second = encodeOfficeDriverFrame({ id: "two", value: "b".repeat(20) }, 64);
  const decoder = new OfficeDriverFrameDecoder(64);

  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(2), second])), [
    { id: "one", value: "a".repeat(20) },
    { id: "two", value: "b".repeat(20) },
  ]);
  decoder.finish();

  assert.throws(() => encodeOfficeDriverFrame({ value: "x".repeat(100) }, 32), /office_driver_frame_too_large/u);
  const invalidLength = Buffer.alloc(4);
  invalidLength.writeUInt32LE(65);
  assert.throws(() => new OfficeDriverFrameDecoder(64).push(invalidLength), /office_driver_frame_length_invalid/u);

  const truncated = new OfficeDriverFrameDecoder(64);
  truncated.push(first.subarray(0, first.length - 1));
  assert.throws(() => truncated.finish(), /office_driver_frame_truncated/u);
});

test("Office runtime scopes session ids to the current Desktop generation", async () => {
  const generation = 123_456;
  const publicSessionId = `${generation}:excel-workbook`;
  const commands = [
    request("list", "list_sessions", {}),
    request("read", "read_ranges", { sessionId: publicSessionId, ranges: ["Sheet1!A1"] }),
  ];
  const completed = [];
  const helperCalls = [];
  const helper = {
    async start() {},
    async stop() {},
    async call(command) {
      helperCalls.push(command);
      if (command.method === "driver_status") {
        return success(command.id, {
          helperVersion: "test-helper",
          state: "limited",
          capabilities: ["excel:sessions", "excel:read"],
          officeInstalled: true,
          applicationRunning: true,
          permissionGranted: true,
        });
      }
      if (command.method === "list_sessions") {
        return success(command.id, [{
          id: "excel-workbook",
          generation: 1,
          platform: "darwin",
          application: "excel",
          workbookName: "Budget.xlsx",
          workbookPath: "/tmp/Budget.xlsx",
          activeSheet: "Sheet1",
          readOnly: false,
          dirty: true,
          capabilities: ["excel:sessions", "excel:read"],
        }]);
      }
      assert.equal(command.params.sessionId, "excel-workbook");
      return success(command.id, { sessionId: "excel-workbook", ranges: [] });
    },
  };
  const transport = {
    async publishAvailability(value) {
      assert.equal(value.generation, generation);
    },
    async claim(signal) {
      if (commands.length > 0) return commands.shift();
      return await new Promise((resolve) => signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
    },
    async complete(value) {
      completed.push(value);
    },
  };
  const runtime = new OfficeDriverRuntime({
    daemonBaseUrl: "http://127.0.0.1:1",
    bridgeToken: "test",
    desktopInstanceId: "desktop-test",
    executablePath: "/unused",
    recoveryRoot: "/tmp",
    platform: "darwin",
    helper,
    daemonClientFactory: (observedGeneration) => {
      assert.equal(observedGeneration, generation);
      return transport;
    },
    now: () => generation,
  });

  await runtime.start();
  await waitFor(() => completed.length === 2);
  await runtime.stop();

  assert.equal(completed[0].result[0].id, publicSessionId);
  assert.equal(completed[0].result[0].generation, generation);
  assert.equal(completed[1].result.sessionId, publicSessionId);
  assert.equal(helperCalls.find((command) => command.id === "read").params.sessionId, "excel-workbook");
});

test("Office runtime rejects stale or mismatched session identities before publication", () => {
  const command = request("read", "read_ranges", { sessionId: "8:excel-current", ranges: ["A1"] });
  assert.throws(() => toHelperCommand(command, 9), /office_driver_session_stale/u);
  assert.throws(() => normalizeHelperResult(
    command,
    success(command.id, { sessionId: "excel-other", ranges: [] }),
    8,
  ), /office_driver_session_mismatch/u);

  const save = request("save", "save_workbook", { sessionId: "8:excel-current" });
  assert.deepEqual(
    normalizeHelperResult(save, success(save.id, { sessionId: "excel-current", saved: true }), 8).result,
    { sessionId: "8:excel-current", saved: true },
  );
  assert.throws(
    () => normalizeHelperResult(save, success(save.id, { saved: true }), 8),
    /office_driver_result_invalid/u,
  );
});

test("Office runtime restarts the native helper after a process failure", async () => {
  const generation = 321_000;
  const commands = [request("read-crash", "read_ranges", {
    sessionId: `${generation}:excel-workbook`,
    ranges: ["Sheet1!A1"],
  })];
  const completed = [];
  const published = [];
  let starts = 0;
  let stops = 0;
  const helper = {
    async start() { starts += 1; },
    async stop() { stops += 1; },
    async call(command) {
      if (command.method === "driver_status") {
        return success(command.id, {
          helperVersion: "test-helper",
          state: "limited",
          capabilities: ["excel:sessions", "excel:read"],
          officeInstalled: true,
          applicationRunning: true,
          permissionGranted: true,
        });
      }
      throw new Error("office_driver_exited");
    },
  };
  const runtime = new OfficeDriverRuntime({
    daemonBaseUrl: "http://127.0.0.1:1",
    bridgeToken: "test",
    desktopInstanceId: "desktop-recovery-test",
    executablePath: "/unused",
    recoveryRoot: "/tmp",
    platform: "darwin",
    helper,
    daemonClientFactory: () => ({
      async publishAvailability(value) { published.push(value); },
      async claim(signal) {
        if (commands.length > 0) return commands.shift();
        return await new Promise((resolve) => signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
      },
      async complete(value) { completed.push(value); },
    }),
    now: () => generation,
  });

  try {
    await runtime.start();
    await waitFor(() => completed.length === 1 && starts === 2);

    assert.equal(completed[0].ok, false);
    assert.equal(completed[0].error.code, "office_driver_exited");
    assert.equal(published.length >= 2, true);
  } finally {
    await runtime.stop();
  }
  assert.equal(stops >= 2, true);
});

test("Office driver package paths are fixed to supported platform resources", () => {
  assert.equal(
    resolveOfficeDriverExecutablePath({ appPath: "/app", resourcesRoot: "/resources", packaged: true, platform: "darwin", architecture: "arm64" }),
    "/resources/office-driver/darwin-arm64/OfficeDriver.app/Contents/MacOS/ling-office-driver",
  );
  assert.equal(
    resolveOfficeDriverExecutablePath({ appPath: "/app", resourcesRoot: "/resources", packaged: false, platform: "win32", architecture: "x64" }),
    "/app/dist/office-driver/win32-x64/ling-office-driver.exe",
  );
  assert.equal(resolveOfficeDriverExecutablePath({ appPath: "/app", resourcesRoot: "/resources", packaged: true, platform: "linux", architecture: "x64" }), undefined);
  assert.equal(resolveOfficeDriverExecutablePath({ appPath: "/app", resourcesRoot: "/resources", packaged: true, platform: "darwin", architecture: "x64" }), undefined);
});

function request(id, method, params) {
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    id,
    method,
    params,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: `test:${id}`,
  };
}

function success(id, result) {
  return { protocol: OFFICE_DRIVER_PROTOCOL, id, ok: true, result };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("office_driver_test_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
