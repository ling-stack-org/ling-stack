import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { HomeAssistantFetch } from "../src/device/home-assistant.ts";
import type { MobileStorageLike } from "../src/device/journal.ts";
import { createStandaloneDeviceRuntime } from "../src/device/standalone-runtime.ts";

class MemoryStorage implements MobileStorageLike {
  readonly values: Map<string, string>;

  constructor(values: Iterable<readonly [string, string]> = []) {
    this.values = new Map(values);
  }

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const time = "2026-11-21T10:00:00.000Z";
const options = { randomId: async (prefix: string) => `${prefix}_${randomUUID()}`, now: () => time };
const target = { origin: "https://ha.fixture.example", token: "fixture-credential", entityId: "light.kitchen" };

test("a phone-only Home Assistant diagnosis records scoped facts and restores them without a PC", async () => {
  const storage = new MemoryStorage();
  let requests = 0;
  const fetch: HomeAssistantFetch = async (url, init) => {
    requests += 1;
    assert.equal(url, `${target.origin}/api/states/light.kitchen`);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${target.token}`);
    return Response.json({ entity_id: target.entityId, state: "unavailable", attributes: { text: "untrusted-entity-output" } });
  };
  const phone = await createStandaloneDeviceRuntime({ ...options, storage, fetch });
  await assert.rejects(() => phone.diagnoseHomeAssistant(target), /前台|手机界面/);
  await phone.setForeground(true);
  const result = await phone.diagnoseHomeAssistant(target);
  assert.equal(result.taskStatus, "succeeded");
  assert.equal(result.availability, "unavailable");
  assert.equal(result.entityId, target.entityId);
  const journal = [...storage.values.values()].join("\n");
  for (const value of [target.token, target.origin, "untrusted-entity-output"]) assert.ok(!journal.includes(value));

  const reopened = await createStandaloneDeviceRuntime({ ...options, storage, fetch });
  await reopened.setForeground(true);
  assert.deepEqual(await reopened.listHomeAssistantRuns(), [result]);
  assert.equal(requests, 1);
});

test("phone diagnosis distinguishes missing entities and denied credentials and rejects misbound or oversized results", async () => {
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 403 }),
    Response.json({ entity_id: "light.other", state: "on" }),
    new Response("x".repeat(256 * 1024 + 1)),
  ];
  const phone = await createStandaloneDeviceRuntime({
    ...options,
    storage: new MemoryStorage(),
    fetch: async () => {
      const response = responses.shift();
      assert.ok(response, "invalid input must never call the device");
      return response;
    },
  });
  await phone.setForeground(true);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, origin: "http://ha.fixture.example" }), /HTTPS/);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, origin: "https://ha.fixture.example/path" }), /HTTPS/);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, token: "abc\r\ncredential" }), /令牌/);
  assert.equal((await phone.diagnoseHomeAssistant(target)).availability, "absent");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "permission_denied");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "service_unavailable");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "service_unavailable");
  assert.equal((await phone.listHomeAssistantRuns()).length, 4);
  assert.equal(responses.length, 0);
});

test("a phone restart marks interrupted work unknown without replaying a device request", async () => {
  const storage = new MemoryStorage();
  const began = Promise.withResolvers<void>();
  const stop = new AbortController();
  const phone = await createStandaloneDeviceRuntime({
    ...options,
    storage,
    fetch: async (_url, { signal }) => {
      began.resolve();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("disconnected")), { once: true }));
    },
  });
  await phone.setForeground(true);
  const diagnosis = phone.diagnoseHomeAssistant({ ...target, signal: stop.signal });
  await began.promise;
  const reopenedStorage = new MemoryStorage(storage.values);
  stop.abort();
  assert.equal((await diagnosis).taskStatus, "unknown");

  let resumedRequests = 0;
  const reopened = await createStandaloneDeviceRuntime({
    ...options,
    storage: reopenedStorage,
    fetch: async () => {
      resumedRequests += 1;
      return Response.json({ entity_id: target.entityId, state: "on" });
    },
  });
  await reopened.setForeground(true);
  const [retained] = await reopened.listHomeAssistantRuns();
  assert.equal(retained?.taskStatus, "unknown");
  assert.equal(retained?.availability, undefined);
  assert.equal(resumedRequests, 0);
});
