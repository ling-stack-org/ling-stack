import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";

import { DeviceBrokerError } from "@ling-stack/core";
import {
  assertHomeAssistantCatalogQuery, homeAssistantEntityAvailability, projectHomeAssistantCatalog,
  readHomeAssistantDeviceRegistry,
} from "../dist/features/device-support/adapters/home-assistant-catalog.js";

const observedAt = "2026-11-22T00:00:00.000Z";

test("Home Assistant catalog projections are sorted, paged, typed, and duplicate-safe", () => {
  const page = projectHomeAssistantCatalog(
    { kind: "entities", limit: 2 },
    [
      { entity_id: "sensor.z", state: "unknown" },
      { entity_id: "sensor.a", state: "on" },
      { entity_id: "sensor.m", state: "unavailable" },
    ],
    observedAt,
  );
  assert.deepEqual(page, {
    kind: "entities", observedAt,
    items: [
      { id: "sensor.a", availability: "available" },
      { id: "sensor.m", availability: "unavailable" },
    ],
    nextAfter: "sensor.m",
  });
  assert.deepEqual(projectHomeAssistantCatalog(
    { kind: "entities", after: "sensor.m", limit: 10 },
    [{ entity_id: "sensor.z", state: "on" }], observedAt,
  ).items, [{ id: "sensor.z", availability: "available" }]);
  assert.throws(() => projectHomeAssistantCatalog(
    { kind: "entities", limit: 10 }, [{ entity_id: "sensor.a", state: "on" }, { entity_id: "sensor.a", state: "off" }], observedAt,
  ), (error: unknown) => error instanceof DeviceBrokerError && error.code === "service_unavailable");
  assert.equal(homeAssistantEntityAvailability(""), "unavailable");
  assert.equal(homeAssistantEntityAvailability("unknown"), "unavailable");
  assert.equal(homeAssistantEntityAvailability("on"), "available");
  assert.throws(() => assertHomeAssistantCatalogQuery({ kind: "devices", after: "not-a-device-id", limit: 10 }), /catalog query is invalid/u);
});

test("Home Assistant registry transport authenticates the pinned version and bounds the command", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 4 * 1024 * 1024 });
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const seen: unknown[] = [];
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.2" }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { type?: string; access_token?: string; id?: number };
      seen.push(message);
      if (message.type === "auth" && message.access_token === "token") {
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.2" }));
      } else if (message.type === "config/device_registry/list") {
        socket.send(JSON.stringify({
          id: message.id, type: "result", success: true,
          result: [{ id: "0123456789abcdef0123456789abcdef", disabled_by: null }],
        }));
      }
    });
  });
  const result = await readHomeAssistantDeviceRegistry({
    origin: "http://127.0.0.1:" + address.port, token: "token", version: "2026.11.2", signal: AbortSignal.timeout(2_000),
  });
  assert.deepEqual(result, [{ id: "0123456789abcdef0123456789abcdef", disabled_by: null }]);
  assert.deepEqual(seen, [
    { type: "auth", access_token: "token" },
    { id: 1, type: "config/device_registry/list" },
  ]);
});

test("Home Assistant registry rejects a version change before exposing device data", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.4" }));
    socket.on("message", () => socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.4" })));
  });
  await assert.rejects(() => readHomeAssistantDeviceRegistry({
    origin: "http://127.0.0.1:" + address.port, token: "token", version: "2026.11.2", signal: AbortSignal.timeout(2_000),
  }), (error: unknown) => error instanceof DeviceBrokerError && error.code === "target_changed");
});
