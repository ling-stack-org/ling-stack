import assert from "node:assert/strict";
import test from "node:test";

import { isAdapterManifestV1 } from "@ling-stack/contracts";
import {
  AndroidAdbAdapter,
  HomeAssistantAdapter,
  LinuxSshAdapter,
  PcAdapter,
} from "../dist/features/device-support/adapters/index.js";

const now = "2026-11-21T00:00:00.000Z";

test("Home Assistant adapter keeps credentials out of the profile and distinguishes entity states", async () => {
  const calls: { url: string; method: string; authorization?: string }[] = [];
  const adapter = new HomeAssistantAdapter({
    baseUrl: "https://ha.example.test/",
    token: "secret-token",
    now: () => now,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (url.endsWith("/api/config")) return new Response(JSON.stringify({ version: "2026.11" }), { status: 200 });
      if (url.endsWith("/api/states/light.kitchen")) return new Response(JSON.stringify({ state: "on", attributes: { brightness: 50 } }), { status: 200 });
      if (url.endsWith("/api/states/sensor.unavailable")) return new Response(JSON.stringify({ state: "unavailable", attributes: {} }), { status: 200 });
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(isAdapterManifestV1(adapter.manifest), true);
  const profile = await adapter.discover({ connectionRef: "https://ha.example.test", ownerId: "mobile-1" });
  assert.equal(profile.connectionRefs[0], "https:ha.example.test");
  assert.equal(profile.connectionRefs.some(ref => ref.includes("secret-token")), false);
  assert.deepEqual((await adapter.readEntity("light.kitchen")).availability, "available");
  assert.deepEqual((await adapter.readEntity("sensor.unavailable")).quality, "degraded");
  assert.deepEqual((await adapter.readEntity("sensor.missing")).availability, "absent");
  assert.equal(calls.every(call => call.authorization === "Bearer secret-token"), true);
});

test("PC adapter uses typed executor operations for diagnosis and repair", async () => {
  const operations: string[] = [];
  const adapter = new PcAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { hostname: "test-pc", os: "linux", version: "6.1" }; },
      async readNetwork() { operations.push("readNetwork"); return { connected: false, gatewayReachable: false }; },
      async readServices() { operations.push("readServices"); return [{ name: "network", state: "failed" }]; },
      async repairNetwork() { operations.push("repairNetwork"); return { accepted: true, changed: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "local:test-pc", ownerId: "pc-1" });
  assert.equal(profile.device.kind, "pc");
  const action = await adapter.execute({
    profile,
    capability: adapter.manifest.capabilities.find(capability => capability.id === "pc.repair.network")!,
    request: {
      actionId: "action-1",
      taskId: "task-1",
      targetDeviceId: profile.device.id,
      capabilityId: "pc.repair.network",
      capabilitySchemaVersion: "1.0",
      capabilitySnapshotId: "snapshot-1",
      normalizedInput: { mode: "refresh_dhcp" },
      idempotencyKey: "task-1:action-1",
    },
  });
  assert.equal("action" in action ? action.action.status : action.status, "completed");
  assert.deepEqual(operations, ["inventory", "repairNetwork"]);
});

test("Linux SSH adapter exposes diagnosis and network repair through a fixed operation set", async () => {
  const operations: string[] = [];
  const adapter = new LinuxSshAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { hostname: "linaro-p", kernel: "6.6" }; },
      async readNetwork() { operations.push("readNetwork"); return { connected: true, gatewayReachable: true }; },
      async readWifi() { operations.push("readWifi"); return { connected: false, ssid: "home", gatewayReachable: false, linkError: "association_failed" }; },
      async restartNetwork() { operations.push("restartNetwork"); return { accepted: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "ssh:linaro-p", ownerId: "mobile-1" });
  await adapter.execute({ profile, capability: adapter.manifest.capabilities[1]!, request: {
    actionId: "wifi-action",
    taskId: "wifi-task",
    targetDeviceId: profile.device.id,
    capabilityId: "linux.inspect.wifi",
    capabilitySchemaVersion: "1.0",
    capabilitySnapshotId: "snapshot-1",
    normalizedInput: {},
    idempotencyKey: "wifi-task:wifi-action",
  } });
  assert.deepEqual(operations, ["inventory", "readWifi"]);
});

test("Android ADB adapter exposes fixed head-unit operations and verifies artifact installation", async () => {
  const operations: string[] = [];
  const adapter = new AndroidAdbAdapter({
    now: () => now,
    executor: {
      async inventory() { operations.push("inventory"); return { serial: "head-unit-1", model: "Linaro P", androidVersion: "7.1.2" }; },
      async readPackages() { operations.push("packages"); return [{ packageId: "com.example.carplay", versionName: "1.0" }]; },
      async readLogs() { operations.push("logs"); return "carplay ready"; },
      async installArtifact() { operations.push("install"); return { accepted: true, packageId: "com.example.carplay", versionName: "1.0" }; },
      async reboot() { operations.push("reboot"); return { accepted: true }; },
    },
  });
  const profile = await adapter.discover({ connectionRef: "adb:head-unit-1", ownerId: "pc-1" });
  assert.equal(profile.device.kind, "head_unit");
  const action = await adapter.execute({ profile, capability: { id: "android.install.artifact" }, request: { actionId: "install-1", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "android.install.artifact", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: { artifactDigest: "sha256:app", packageId: "com.example.carplay" }, idempotencyKey: "task-1:install-1" } });
  assert.equal("action" in action ? action.action.status : action.status, "completed");
  const actionResult = "action" in action ? action.action : action;
  assert.equal((await adapter.verify({ profile, request: { actionId: "install-1", taskId: "task-1", targetDeviceId: profile.device.id, capabilityId: "android.install.artifact", capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", normalizedInput: { artifactDigest: "sha256:app", packageId: "com.example.carplay" }, idempotencyKey: "task-1:install-1" }, action: actionResult })).status, "verified");
  assert.deepEqual(operations, ["inventory", "install", "packages"]);
});
