import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseProjectionRegistry } from "../dist/features/computer-use/registry.js";

test("Computer Use registry prunes terminal projections after the reconnect retention window", () => {
  let now = new Date("2026-07-16T00:00:00.000Z");
  const registry = new ComputerUseProjectionRegistry({
    now: () => now,
    terminalRetentionMs: 1_000,
    eventRetentionMs: 10_000,
  });
  registry.upsert("/workspace", projection({ status: "running", updatedAt: now.toISOString() }));
  now = new Date("2026-07-16T00:00:01.000Z");
  registry.upsert("/workspace", projection({
    status: "succeeded",
    updatedAt: now.toISOString(),
    terminalAt: now.toISOString(),
  }));
  assert.equal(registry.list("/workspace").length, 1);

  now = new Date("2026-07-16T00:00:02.001Z");
  assert.deepEqual(registry.list("/workspace"), []);
  assert.deepEqual(
    registry.listEvents("/workspace").events.map((event) => event.kind),
    ["upsert", "upsert", "remove"],
  );
});

test("Computer Use descriptor leases renew with a sliding limit and an absolute cap", () => {
  let now = new Date("2026-07-16T00:00:00.000Z");
  const registry = new ComputerUseProjectionRegistry({
    now: () => now,
    descriptorLeaseMs: 1_000,
    descriptorMaxLifetimeMs: 3_000,
  });
  registry.registerPrivateDescriptor("/workspace", descriptor("2099-01-01T00:00:00.000Z"));

  const first = registry.resolvePrivateDescriptor("/workspace", "descriptor-1", 1, now);
  assert.equal(first?.authorization.expiresAt, "2026-07-16T00:00:01.000Z");

  now = new Date("2026-07-16T00:00:00.500Z");
  const renewed = registry.renewPrivateDescriptor("/workspace", "descriptor-1", 1, now);
  assert.equal(renewed?.authorization.expiresAt, "2026-07-16T00:00:01.500Z");

  now = new Date("2026-07-16T00:00:03.001Z");
  assert.equal(registry.resolvePrivateDescriptor("/workspace", "descriptor-1", 1, now), undefined);
});

test("Computer Use descriptor re-registration does not reset an existing revision's absolute lease", () => {
  let now = new Date("2026-07-16T00:00:00.000Z");
  const registry = new ComputerUseProjectionRegistry({
    now: () => now,
    descriptorLeaseMs: 1_000,
    descriptorMaxLifetimeMs: 3_000,
  });
  registry.registerPrivateDescriptor("/workspace", descriptor("2099-01-01T00:00:00.000Z"));
  now = new Date("2026-07-16T00:00:02.500Z");
  registry.registerPrivateDescriptor("/workspace", descriptor("2099-01-01T00:00:00.000Z"));
  now = new Date("2026-07-16T00:00:03.001Z");
  assert.equal(registry.resolvePrivateDescriptor("/workspace", "descriptor-1", 1, now), undefined);
});

function projection(overrides = {}) {
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    status: overrides.status ?? "running",
    target: { kind: "window", displayName: "Browser" },
    preview: { descriptorId: "descriptor-1", revision: 1, cursorAvailable: true },
    startedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-16T00:00:00.000Z",
    ...(overrides.terminalAt ? { terminalAt: overrides.terminalAt } : {}),
  };
}

function descriptor(expiresAt) {
  return {
    descriptorId: "descriptor-1",
    revision: 1,
    platform: "macos",
    sourceKind: "window",
    target: { processId: 42, nativeWindowId: "window-1" },
    authorization: { grantId: "grant-1", expiresAt },
  };
}
