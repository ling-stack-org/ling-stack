import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_CONTRACT_MAJOR_V1,
  isAdapterManifestV1,
  isCapabilityDescriptorV1,
  isDeviceActionRequestV1,
  isDeviceCapabilitySnapshotV1,
  isDeviceIdentityV1,
  isDeviceRecoveryPlanV1,
  negotiateDeviceContractMajor,
} from "../dist/device.js";
import { isDeviceCapabilitySchemaV1, matchesDeviceCapabilitySchemaV1 } from "../dist/device-capability-schema.js";

test("device capability schemas validate nested inputs and reject undeclared schema keywords", () => {
  const schema = {
    type: "object", required: ["ports"], additionalProperties: false,
    properties: { ports: {
      type: "array", items: {
        type: "object", required: ["port", "mode"], additionalProperties: false,
        properties: { port: { type: "integer", minimum: 1, maximum: 65535 }, mode: { enum: ["observe", "configure"] } },
      },
    } },
  } as const;
  assert.ok(isDeviceCapabilitySchemaV1(schema));
  assert.ok(matchesDeviceCapabilitySchemaV1({ ports: [{ port: 443, mode: "observe" }] }, schema));
  assert.equal(matchesDeviceCapabilitySchemaV1({}, schema), false);
  assert.equal(matchesDeviceCapabilitySchemaV1({ ports: [{ port: 0, mode: "observe" }] }, schema), false);
  assert.equal(matchesDeviceCapabilitySchemaV1({ ports: [{ port: 443, mode: "unknown" }] }, schema), false);
  assert.equal(matchesDeviceCapabilitySchemaV1({ ports: [], extra: true }, schema), false);
  assert.equal(isDeviceCapabilitySchemaV1({ type: "object", required: ["port", "port"] }), false);
  assert.equal(isDeviceCapabilitySchemaV1({ type: "array", items: { type: "string", pattern: "^example" } }), false);
});

const identity = {
  id: "device-linux-1",
  ownerScope: "workspace-1",
  displayName: "Linaro board",
  kind: "linux",
  lifecycleStatus: "healthy",
  profileRevision: "profile-1",
} as const;

const capability = {
  id: "linux.inspect.network",
  schemaVersion: "1.0",
  semanticVerb: "inspect.network",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  sideEffect: "read_only",
  approvalClass: "allow",
  requiredPermissions: ["ssh"],
  prerequisites: [],
  timeoutMs: 10_000,
  responseBytesLimit: 64 * 1024,
  idempotency: "request",
  supportedDeviceKinds: ["linux"],
  supportedTransports: ["ssh"],
  displayMetadata: { label: "Inspect network", category: "diagnostics" },
} as const;

const transportDeployment = {
  transport: "ssh",
  mode: "none",
  pairing: "credential_reference",
  removal: "revoke_credentials",
} as const;

test("device contracts accept a complete identity and snapshot", () => {
  assert.equal(isDeviceIdentityV1(identity), true);
  assert.equal(isDeviceCapabilitySnapshotV1({
    snapshotId: "snapshot-1",
    deviceId: identity.id,
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    contractMajor: DEVICE_CONTRACT_MAJOR_V1,
    connectionRevision: "connection-1",
    capabilities: [capability],
    observedAt: "2026-11-21T00:00:00.000Z",
    freshnessUntil: "2026-11-21T00:05:00.000Z",
  }), true);
});

test("strict device validators reject unknown fields and incompatible versions", () => {
  assert.equal(isDeviceIdentityV1({ ...identity, unexpected: true }), false);
  assert.equal(isDeviceCapabilitySnapshotV1({
    snapshotId: "snapshot-1",
    deviceId: identity.id,
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    contractMajor: 2,
    connectionRevision: "connection-1",
    capabilities: [capability],
    observedAt: "2026-11-21T00:00:00.000Z",
    freshnessUntil: "2026-11-21T00:05:00.000Z",
  }), false);
});

test("adapter manifest and idempotent action request validate together", () => {
  assert.equal(isAdapterManifestV1({
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    contractMajor: DEVICE_CONTRACT_MAJOR_V1,
    supportedDeviceKinds: ["linux"],
    supportedTransports: ["ssh"],
    transportDeployments: [transportDeployment],
    requiredRuntime: "pc",
    authenticationMethods: ["ssh_key"],
    capabilities: [capability],
    removalBehavior: "revoke_and_disconnect",
  }), true);
  assert.equal(isDeviceActionRequestV1({
    actionId: "action-1",
    taskId: "task-1",
    targetDeviceId: identity.id,
    capabilityId: capability.id,
    capabilitySchemaVersion: capability.schemaVersion,
    capabilitySnapshotId: "snapshot-1",
    normalizedInput: { includeDns: true },
    idempotencyKey: "task-1-action-1",
  }), true);
});

test("display metadata is additive while unknown wire fields remain rejected", () => {
  assert.equal(isAdapterManifestV1({
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    contractMajor: DEVICE_CONTRACT_MAJOR_V1,
    supportedDeviceKinds: ["linux"],
    supportedTransports: ["ssh"],
    transportDeployments: [transportDeployment],
    requiredRuntime: "pc",
    authenticationMethods: ["ssh_key"],
    capabilities: [capability],
    removalBehavior: "revoke_and_disconnect",
    displayMetadata: { label: "Linux SSH" },
  }), true);
  assert.equal(isAdapterManifestV1({
    adapterId: "linux-ssh",
    adapterVersion: "1.0.0",
    contractMajor: DEVICE_CONTRACT_MAJOR_V1,
    supportedDeviceKinds: ["linux"],
    supportedTransports: ["ssh"],
    transportDeployments: [transportDeployment],
    requiredRuntime: "pc",
    authenticationMethods: ["ssh_key"],
    capabilities: [capability],
    removalBehavior: "revoke_and_disconnect",
    displayMetadata: { unexpected: true },
  }), false);
});

test("device contract negotiation selects only the supported major", () => {
  assert.equal(negotiateDeviceContractMajor([1, 2], [1]), 1);
  assert.equal(negotiateDeviceContractMajor([2], [1]), undefined);
});

test("a control-path recovery plan uses an opaque route revision and a verified-write capability", () => {
  const plan = { kind: "alternate_route", routeRevision: "usb:rev-1", baselineObservationId: "before-1", verifyBy: "2026-11-21T00:01:00.000Z" };
  assert.equal(isDeviceRecoveryPlanV1(plan), true);
  assert.equal(isDeviceRecoveryPlanV1({ ...plan, routeRevision: "ssh://host" }), false);
  assert.equal(isDeviceRecoveryPlanV1({ ...plan, credentialRef: "secret" }), false);
  assert.equal(isDeviceRecoveryPlanV1({ ...plan, verifyBy: "2026-11-21" }), false);
  assert.equal(isCapabilityDescriptorV1({ ...capability, requiresRecovery: true }), false);
  assert.equal(isCapabilityDescriptorV1({
    ...capability, sideEffect: "reversible", requiresRecovery: true, verificationCapabilityId: "linux.inspect.network",
  }), true);
});
