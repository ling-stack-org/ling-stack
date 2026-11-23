import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteDeviceCollaborationCommandV1, RemotePhoneTaskProjectionV1 } from "@ling-stack/contracts";
import { SqliteDeviceDeveloperStore } from "@ling-stack/core";
import { PhoneTaskCollaboration } from "../dist/features/remote-access/phone-task-collaboration.js";

const principal = {
  gatewayId: "gateway-a", deviceId: "paired-phone", deviceEpoch: 1, workspaceId: "workspace-a",
  workspaceBindingId: "bound-workspace", policyVersion: 3,
};
const now = "2026-11-23T10:00:00.000Z";
const expiresAt = "2026-11-23T10:30:00.000Z";
const projection: RemotePhoneTaskProjectionV1 = {
  taskId: "phone-task", ownerId: "phone-owner", targetDeviceId: "external-linux",
  status: "succeeded", updatedAt: now,
  attempt: { attemptId: "attempt-1", capabilityId: "linux.wifi.read", status: "completed", connectionRevision: "link-7" },
  facts: { kind: "linux_network", network: { connected: true, wifiAssociated: true, routeAvailable: false } },
};
const publish = { kind: "publish", expectedRevision: 0, expiresAt, projection } as const;
const note = { shareId: "share-a", expectedRevision: 1, proposalId: "analysis-1", text: "Check the default route." };

test("paired authority fences shares, proposal decisions, and exact retries", t => {
  const store = new SqliteDeviceDeveloperStore();
  t.after(() => store.close());
  const service = new PhoneTaskCollaboration(store);
  const mobile = (action: RemoteDeviceCollaborationCommandV1["action"], overrides: Partial<RemoteDeviceCollaborationCommandV1> = {}) =>
    service.fromPhone(principal, { commandId: "command", workspaceId: principal.workspaceId, shareId: "share-a", action, ...overrides }, now);
  const shared = mobile(publish);
  assert.equal(shared.revision, 1);
  assert.deepEqual(mobile(publish), shared);
  assert.throws(() => mobile(publish, { shareId: "share-b" }), { code: "idempotency_conflict" });
  assert.throws(() => mobile({ kind: "read" }, { workspaceId: "different-workspace" }), { code: "workspace_not_allowed" });
  const changedAuthorities = [
    { gatewayId: "gateway-b" }, { deviceId: "other-phone" }, { deviceEpoch: 2 }, { policyVersion: 4 }, { workspaceBindingId: "different-binding" },
  ];
  for (const change of changedAuthorities) {
    const replacement = { ...principal, ...change };
    assert.deepEqual(service.listForPc(replacement, now), []);
    assert.throws(() => service.proposeFromPc(replacement, note, now), { code: "binding_changed" });
    assert.throws(() => service.fromPhone(replacement, { commandId: "command", workspaceId: principal.workspaceId,
      shareId: "share-a", action: { kind: "read" } }, now), { code: "binding_changed" });
  }
  assert.throws(() => mobile({ ...publish, expectedRevision: 1, projection: { ...projection, targetDeviceId: "external-other" } }), {
    code: "binding_changed",
  });
  assert.throws(() => mobile({ ...publish, expectedRevision: 1, projection: { ...projection, ownerId: "other-owner" } }), {
    code: "binding_changed",
  });
  const proposed = service.proposeFromPc(principal, note, now);
  assert.equal(proposed.state, "active");
  assert.deepEqual(service.proposeFromPc(principal, note, now), proposed);
  assert.throws(() => service.proposeFromPc(principal, { ...note, text: "Different analysis" }, now), { code: "idempotency_conflict" });
  const decide = { kind: "decide", proposalId: note.proposalId, expectedRevision: 1, decision: "accepted" } as const;
  const accepted = mobile(decide);
  assert.ok(accepted.state === "active");
  assert.equal(accepted.proposals[0]?.status, "accepted");
  assert.deepEqual(mobile(decide), accepted);
  assert.throws(() => mobile({ ...decide, decision: "rejected" }), { code: "idempotency_conflict" });
  const revoked = mobile({ kind: "revoke" });
  assert.deepEqual(revoked, { workspaceId: principal.workspaceId, shareId: "share-a", revision: 2, expiresAt, state: "revoked" });
  assert.deepEqual(mobile({ kind: "revoke" }), revoked);
  assert.deepEqual(service.listForPc(principal, now), []);
  assert.equal(store.getProposal(note.proposalId)?.status, "accepted");
  assert.throws(() => mobile(publish), { code: "command_expired" });
});

test("expiry keeps diagnostics and proposals out of both peer views", t => {
  const store = new SqliteDeviceDeveloperStore();
  t.after(() => store.close());
  const service = new PhoneTaskCollaboration(store);
  const command = { commandId: "command", workspaceId: principal.workspaceId, shareId: "share-a", action: publish };
  service.fromPhone(principal, command, now);
  service.proposeFromPc(principal, note, now);
  assert.deepEqual(service.listForPc(principal, expiresAt), []);
  assert.deepEqual(service.fromPhone(principal, { ...command, action: { kind: "read" } }, expiresAt),
    { workspaceId: principal.workspaceId, shareId: "share-a", revision: 1, expiresAt, state: "expired" });
  assert.throws(() => service.fromPhone(principal, {
    ...command, action: { kind: "decide", expectedRevision: 1, proposalId: note.proposalId, decision: "accepted" },
  }, expiresAt), { code: "command_expired" });
});
