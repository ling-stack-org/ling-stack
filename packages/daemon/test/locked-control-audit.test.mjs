import assert from "node:assert/strict";
import test from "node:test";

import { createLockedControlAuditPublisher } from "../dist/features/computer-use/locked-control-audit.js";

test("locked lifecycle audit reuses the durable control-plane store", () => {
  const persisted = [];
  const published = [];
  const store = {
    appendControlPlaneEvent(input, now) {
      persisted.push({ input, now });
      return {
        seq: persisted.length,
        ts: now,
        ...input,
        data: input.data ?? {},
      };
    },
  };
  const publisher = createLockedControlAuditPublisher({
    storeRegistry: {
      findStoreForRun(runId, cwd) {
        assert.equal(runId, "run-1");
        assert.equal(cwd, "/workspace");
        return store;
      },
      getStore() {
        throw new Error("known run should select its store");
      },
    },
    controlPlaneEvents: { publish: (event) => published.push(event) },
  });
  const event = {
    schemaVersion: 1,
    auditId: "audit-1",
    event: "locked_control_authorization_requested",
    platform: "darwin",
    occurredAt: "2099-01-01T00:00:00.000Z",
    workspaceCwd: "/workspace",
    intentId: "intent-1",
    runId: "run-1",
    computerUseSessionId: "session-1",
    ttlCeilingSeconds: 900,
  };
  publisher.append(event);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].input.domain, "runs");
  assert.equal(persisted[0].input.entityType, "locked_computer_control");
  assert.equal(persisted[0].input.action, event.event);
  assert.deepEqual(persisted[0].input.data, event);
  assert.deepEqual(published, [{
    seq: 1,
    ts: event.occurredAt,
    ...persisted[0].input,
    data: event,
  }]);
});

test("locked lifecycle audit rejects absent workspace and expanded payloads", () => {
  const publisher = createLockedControlAuditPublisher({
    storeRegistry: { getStore() { throw new Error("must not persist invalid audit"); } },
    controlPlaneEvents: { publish() { throw new Error("must not publish invalid audit"); } },
  });
  assert.throws(() => publisher.append({
    schemaVersion: 1,
    auditId: "audit-1",
    event: "locked_control_capability_evaluated",
    platform: "darwin",
    occurredAt: "2099-01-01T00:00:00.000Z",
    capability: "disabled_by_build",
    adapterVersion: "darwin-v1",
    buildId: "build-1",
    reason: "locked_control_disabled_by_build",
  }), /locked_control_audit_invalid/);
  assert.throws(() => publisher.append({
    schemaVersion: 1,
    auditId: "audit-1",
    event: "locked_control_capability_evaluated",
    platform: "darwin",
    occurredAt: "2099-01-01T00:00:00.000Z",
    workspaceCwd: "/workspace",
    capability: "disabled_by_build",
    adapterVersion: "darwin-v1",
    buildId: "build-1",
    reason: "locked_control_disabled_by_build",
    screenshot: "forbidden",
  }), /locked_control_audit_invalid/);
});
