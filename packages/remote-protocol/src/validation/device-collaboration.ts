import {
  DEVICE_TASK_STATUSES_V1, REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES, REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS, REMOTE_PROTOCOL_LIMITS,
  type RemoteDeviceAnalysisProposalV1, type RemoteDeviceCollaborationActionV1, type RemoteDeviceCollaborationCommandV1,
  type RemoteDeviceCollaborationViewV1, type RemotePhoneTaskProjectionV1,
} from "@ling-stack/contracts";
import { RemoteProtocolError } from "../errors.js";
import {
  assertStrictKeys, expectArray, expectBoolean, expectEnum, expectIdentifier, expectRecord, expectRfc3339, expectSafeInteger, expectString,
} from "./primitives.js";

export function validateDeviceCollaborationCommand(value: unknown, path: string): RemoteDeviceCollaborationCommandV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["commandId", "workspaceId", "shareId", "action"], [], path);
  return {
    commandId: expectIdentifier(row.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(row.workspaceId, `${path}.workspaceId`),
    shareId: expectIdentifier(row.shareId, `${path}.shareId`),
    action: validateAction(row.action, `${path}.action`),
  };
}

function validateAction(value: unknown, path: string): RemoteDeviceCollaborationActionV1 {
  const row = expectRecord(value, path);
  const kind = expectEnum(row.kind, ["publish", "read", "decide", "revoke"] as const, `${path}.kind`);
  if (kind === "publish") {
    assertStrictKeys(row, ["kind", "expectedRevision", "expiresAt", "projection"], [], path);
    return {
      kind, expectedRevision: expectSafeInteger(row.expectedRevision, `${path}.expectedRevision`, { minimum: 0 }),
      expiresAt: expectRfc3339(row.expiresAt, `${path}.expiresAt`),
      projection: validatePhoneTaskProjection(row.projection, `${path}.projection`),
    };
  }
  if (kind === "decide") {
    assertStrictKeys(row, ["kind", "expectedRevision", "proposalId", "decision"], [], path);
    return {
      kind, expectedRevision: expectSafeInteger(row.expectedRevision, `${path}.expectedRevision`, { minimum: 1 }),
      proposalId: expectIdentifier(row.proposalId, `${path}.proposalId`),
      decision: expectEnum(row.decision, ["accepted", "rejected"] as const, `${path}.decision`),
    };
  }
  assertStrictKeys(row, ["kind"], [], path);
  return { kind };
}

export function validateDeviceCollaborationView(value: unknown, path: string): RemoteDeviceCollaborationViewV1 {
  const row = expectRecord(value, path);
  const state = expectEnum(row.state, ["active", "revoked", "expired"] as const, `${path}.state`);
  const keys = ["workspaceId", "shareId", "revision", "expiresAt", "state"];
  assertStrictKeys(row, state === "active" ? [...keys, "projection", "proposals"] : keys, [], path);
  const common = {
    workspaceId: expectIdentifier(row.workspaceId, `${path}.workspaceId`),
    shareId: expectIdentifier(row.shareId, `${path}.shareId`),
    revision: expectSafeInteger(row.revision, `${path}.revision`, { minimum: 1 }),
    expiresAt: expectRfc3339(row.expiresAt, `${path}.expiresAt`),
  };
  if (state !== "active") return { ...common, state };
  const proposals = expectArray(row.proposals, `${path}.proposals`, validateAnalysisProposal, { maxItems: REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS });
  if (new Set(proposals.map(proposal => proposal.proposalId)).size !== proposals.length) {
    throw new RemoteProtocolError("invalid_field", "Analysis proposal identifiers must be unique", `${path}.proposals`);
  }
  return { ...common, state, projection: validatePhoneTaskProjection(row.projection, `${path}.projection`), proposals };
}

function validateAnalysisProposal(value: unknown, path: string): RemoteDeviceAnalysisProposalV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["proposalId", "status", "text", "createdAt"], [], path);
  return {
    proposalId: expectIdentifier(row.proposalId, `${path}.proposalId`),
    status: expectEnum(row.status, ["proposed", "accepted", "rejected"] as const, `${path}.status`),
    text: expectString(row.text, `${path}.text`, { minBytes: 1, maxBytes: REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES }),
    createdAt: expectRfc3339(row.createdAt, `${path}.createdAt`),
  };
}

function validatePhoneTaskProjection(value: unknown, path: string): RemotePhoneTaskProjectionV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["taskId", "ownerId", "targetDeviceId", "status", "updatedAt", "attempt"], ["facts"], path);
  return {
    taskId: expectIdentifier(row.taskId, `${path}.taskId`),
    ownerId: expectIdentifier(row.ownerId, `${path}.ownerId`),
    targetDeviceId: expectIdentifier(row.targetDeviceId, `${path}.targetDeviceId`),
    status: expectEnum(row.status, DEVICE_TASK_STATUSES_V1, `${path}.status`),
    updatedAt: expectRfc3339(row.updatedAt, `${path}.updatedAt`),
    attempt: validateAttempt(row.attempt, `${path}.attempt`),
    ...(row.facts === undefined ? {} : { facts: validateFacts(row.facts, `${path}.facts`) }),
  };
}

function validateAttempt(value: unknown, path: string): RemotePhoneTaskProjectionV1["attempt"] {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["attemptId", "capabilityId", "connectionRevision", "status"], ["verification"], path);
  const verification = row.verification === undefined ? undefined : expectRecord(row.verification, `${path}.verification`);
  if (verification) assertStrictKeys(verification, ["evidenceId", "connectionRevision", "status"], [], `${path}.verification`);
  return {
    attemptId: expectJournalIdentifier(row.attemptId, `${path}.attemptId`),
    capabilityId: expectIdentifier(row.capabilityId, `${path}.capabilityId`),
    connectionRevision: expectIdentifier(row.connectionRevision, `${path}.connectionRevision`),
    status: expectEnum(row.status, ["prepared", "dispatched", "completed", "failed", "cancelled", "unknown"] as const, `${path}.status`),
    ...(verification ? { verification: {
      evidenceId: expectJournalIdentifier(verification.evidenceId, `${path}.verification.evidenceId`),
      connectionRevision: expectIdentifier(verification.connectionRevision, `${path}.verification.connectionRevision`),
      status: expectEnum(verification.status, ["verified", "failed", "not_evaluable"] as const, `${path}.verification.status`),
    } } : {}),
  };
}

export function expectJournalIdentifier(value: unknown, path: string): string {
  const id = expectString(value, path, { minBytes: 1, maxBytes: REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(id)) {
    throw new RemoteProtocolError("invalid_field", "Expected a device journal identifier", path);
  }
  return id;
}

function validateFacts(value: unknown, path: string): NonNullable<RemotePhoneTaskProjectionV1["facts"]> {
  const row = expectRecord(value, path);
  const kind = expectEnum(row.kind, ["linux_network", "home_assistant"] as const, `${path}.kind`);
  if (kind === "home_assistant") {
    assertStrictKeys(row, ["kind", "availability"], ["automationEnabled"], path);
    return {
      kind, availability: expectEnum(row.availability, ["available", "unavailable", "absent"] as const, `${path}.availability`),
      ...(row.automationEnabled === undefined ? {} : { automationEnabled: expectBoolean(row.automationEnabled, `${path}.automationEnabled`) }),
    };
  }
  assertStrictKeys(row, ["kind", "network"], [], path);
  const network = expectRecord(row.network, `${path}.network`);
  assertStrictKeys(network, ["connected"], ["routeAvailable", "dnsNameResolved", "wifiAssociated", "linkError"], `${path}.network`);
  return { kind, network: {
    connected: expectBoolean(network.connected, `${path}.network.connected`),
    ...(network.routeAvailable === undefined ? {} : { routeAvailable: expectBoolean(network.routeAvailable, `${path}.network.routeAvailable`) }),
    ...(network.dnsNameResolved === undefined ? {} : { dnsNameResolved: expectBoolean(network.dnsNameResolved, `${path}.network.dnsNameResolved`) }),
    ...(network.wifiAssociated === undefined ? {} : { wifiAssociated: expectBoolean(network.wifiAssociated, `${path}.network.wifiAssociated`) }),
    ...(network.linkError === undefined ? {} : { linkError: expectEnum(network.linkError,
      ["wireless_tools_unavailable", "wireless_interface_not_found", "wifi_observation_failed"] as const, `${path}.network.linkError`) }),
  } };
}
