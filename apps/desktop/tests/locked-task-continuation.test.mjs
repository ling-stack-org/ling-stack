import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileLockedTaskContinuationPreferenceStore,
  sanitizeLockedTaskContinuationPreference,
} from "../dist/main/locked-task-continuation/preference-store.js";
import {
  LockedTaskContinuationDaemonClientError,
  createLockedTaskContinuationDaemonClient,
} from "../dist/main/locked-task-continuation/daemon-client.js";

test("locked-task preference defaults on and rejects malformed persisted values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-locked-task-preference-"));
  const filePath = join(directory, "preference.json");
  const store = new FileLockedTaskContinuationPreferenceStore(filePath);
  try {
    assert.deepEqual(await store.load(), { schemaVersion: 1, continueWhileLocked: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, continueWhileLocked: "no" }));
    assert.deepEqual(await store.load(), { schemaVersion: 1, continueWhileLocked: true });
    assert.deepEqual(sanitizeLockedTaskContinuationPreference({
      schemaVersion: 1,
      continueWhileLocked: false,
      ignored: "removed",
    }), { schemaVersion: 1, continueWhileLocked: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked-task preference serializes concurrent saves with last invocation winning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-locked-task-save-"));
  const filePath = join(directory, "preference.json");
  const store = new FileLockedTaskContinuationPreferenceStore(filePath);
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.save({
      schemaVersion: 1,
      continueWhileLocked: index === 11,
    })));
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      schemaVersion: 1,
      continueWhileLocked: true,
    });
    assert.deepEqual(await readdir(directory), ["preference.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked-task daemon client sends only the Desktop bridge payload and validates snapshots", async () => {
  const requests = [];
  const client = createLockedTaskContinuationDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "desktop-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        revision: 2,
        continueWhileLocked: false,
        locked: true,
        blocked: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.deepEqual(await client.publish({
    workspaceCwd: "/tmp/workspace",
    desktopInstanceId: "desktop-instance",
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: true,
  }), {
    revision: 2,
    continueWhileLocked: false,
    locked: true,
    blocked: true,
  });
  assert.equal(requests[0].url, "http://127.0.0.1:17891/computer-use/locked-task-continuation/desktop/state");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["X-Ling-Desktop-Bridge-Token"], "desktop-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    workspaceCwd: "/tmp/workspace",
    desktopInstanceId: "desktop-instance",
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: true,
  });
  await client.release({ workspaceCwd: "/tmp/workspace", desktopInstanceId: "desktop-instance" });
  assert.equal(requests[1].url, "http://127.0.0.1:17891/computer-use/locked-task-continuation/desktop/release");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    workspaceCwd: "/tmp/workspace",
    desktopInstanceId: "desktop-instance",
  });

  const invalidClient = createLockedTaskContinuationDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "desktop-token",
    fetch: async () => new Response(JSON.stringify({
      revision: 1,
      continueWhileLocked: true,
      locked: true,
      blocked: true,
    }), { status: 200 }),
  });
  await assert.rejects(
    invalidClient.publish({
      workspaceCwd: "/tmp/workspace",
      desktopInstanceId: "desktop-instance",
      leaseTtlMs: 15_000,
      continueWhileLocked: true,
      locked: true,
    }),
    (error) => error instanceof LockedTaskContinuationDaemonClientError
      && error.clientCode === "invalid_response",
  );

  const timedOutClient = createLockedTaskContinuationDaemonClient({
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "desktop-token",
    requestTimeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    timedOutClient.publish({
      workspaceCwd: "/tmp/workspace",
      desktopInstanceId: "desktop-instance",
      leaseTtlMs: 15_000,
      continueWhileLocked: true,
      locked: false,
    }),
    (error) => error instanceof LockedTaskContinuationDaemonClientError
      && error.clientCode === "request_failed",
  );
});
