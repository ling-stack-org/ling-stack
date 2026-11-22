import {
  REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, REMOTE_DEVICE_ARTIFACT_MAX_BYTES, REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS,
  isRemoteDeviceArtifactName, type RemoteDeviceArtifactActionV1, type RemoteDeviceArtifactCommandV1,
  type RemoteDeviceArtifactManifestV1, type RemoteDeviceArtifactOfferV1, type RemoteDeviceArtifactReceiptV1, type RemoteDeviceArtifactResultV1,
} from "@ling-stack/contracts";
import { RemoteProtocolError } from "../errors.js";
import { expectJournalIdentifier } from "./device-collaboration.js";
import {
  assertStrictKeys, expectArray, expectEnum, expectEs256Signature, expectIdentifier, expectLiteral,
  expectRecord, expectRfc3339, expectSafeInteger, expectString,
} from "./primitives.js";

const chunkIndexMax = Math.ceil(REMOTE_DEVICE_ARTIFACT_MAX_BYTES / REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES) - 1;

export function validateDeviceArtifactCommand(value: unknown, path: string): RemoteDeviceArtifactCommandV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["commandId", "workspaceId", "shareId", "expectedRevision", "action"], [], path);
  return {
    commandId: expectIdentifier(row.commandId, `${path}.commandId`),
    workspaceId: expectIdentifier(row.workspaceId, `${path}.workspaceId`),
    shareId: expectIdentifier(row.shareId, `${path}.shareId`),
    expectedRevision: expectSafeInteger(row.expectedRevision, `${path}.expectedRevision`, { minimum: 1 }),
    action: validateAction(row.action, `${path}.action`),
  };
}

function validateAction(value: unknown, path: string): RemoteDeviceArtifactActionV1 {
  const row = expectRecord(value, path);
  const kind = expectEnum(row.kind, ["list", "decide", "chunk", "receipt"] as const, `${path}.kind`);
  if (kind === "list") {
    assertStrictKeys(row, ["kind"], [], path);
    return { kind };
  }
  const field = kind === "decide" ? "decision" : kind === "chunk" ? "index" : "receipt";
  assertStrictKeys(row, ["kind", "proposalId", field], [], path);
  const proposalId = expectIdentifier(row.proposalId, `${path}.proposalId`);
  if (kind === "decide") return { kind, proposalId, decision: expectEnum(row.decision, ["accepted", "rejected"] as const, `${path}.decision`) };
  if (kind === "chunk") return { kind, proposalId, index: readIndex(row.index, `${path}.index`) };
  return { kind, proposalId, receipt: readReceipt(row.receipt, `${path}.receipt`) };
}

export function validateDeviceArtifactResult(value: unknown, path: string): RemoteDeviceArtifactResultV1 {
  const row = expectRecord(value, path);
  const kind = expectLiteral(row.kind, "device_artifact", `${path}.kind`);
  const operation = expectEnum(row.operation, ["list", "decide", "chunk", "receipt"] as const, `${path}.operation`);
  const common = ["kind", "operation", "shareId", "revision"];
  const shareId = expectIdentifier(row.shareId, `${path}.shareId`);
  const revision = expectSafeInteger(row.revision, `${path}.revision`, { minimum: 1 });
  if (operation === "list") {
    assertStrictKeys(row, [...common, "offers"], [], path);
    const offers = expectArray(row.offers, `${path}.offers`, validateDeviceArtifactOffer, { maxItems: REMOTE_DEVICE_COLLABORATION_MAX_PROPOSALS });
    if (new Set(offers.map(offer => offer.manifest.proposalId)).size !== offers.length
      || offers.some(offer => offer.manifest.shareId !== shareId || offer.manifest.revision !== revision)) {
      throw new RemoteProtocolError("invalid_field", "Artifact offers do not match the result binding", `${path}.offers`);
    }
    return { kind, operation, shareId, revision, offers };
  }
  if (operation === "chunk") {
    assertStrictKeys(row, [...common, "proposalId", "chunk"], [], path);
    const chunkPath = `${path}.chunk`;
    const chunk = expectRecord(row.chunk, chunkPath);
    assertStrictKeys(chunk, ["index", "digest", "bytes", "signature"], [], chunkPath);
    const bytes = expectString(chunk.bytes, `${chunkPath}.bytes`, { minBytes: 1, maxBytes: Math.ceil(REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES * 4 / 3) });
    if (!/^[A-Za-z0-9_-]+$/u.test(bytes)) throw new RemoteProtocolError("invalid_field", "Expected encoded artifact bytes", `${chunkPath}.bytes`);
    return { kind, operation, shareId, revision, proposalId: expectIdentifier(row.proposalId, `${path}.proposalId`), chunk: {
      index: readIndex(chunk.index, `${chunkPath}.index`), digest: readDigest(chunk.digest, `${chunkPath}.digest`),
      bytes, signature: expectEs256Signature(chunk.signature, `${chunkPath}.signature`),
    } };
  }
  assertStrictKeys(row, [...common, "offer"], [], path);
  const offer = validateDeviceArtifactOffer(row.offer, `${path}.offer`);
  if (offer.manifest.shareId !== shareId || offer.manifest.revision !== revision || (operation === "receipt" && !offer.receipt)) {
    throw new RemoteProtocolError("invalid_field", "Artifact offer does not match the result binding", `${path}.offer`);
  }
  return { kind, operation, shareId, revision, offer };
}

export function validateDeviceArtifactOffer(value: unknown, path: string): RemoteDeviceArtifactOfferV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["manifest", "signature", "status"], ["receipt"], path);
  const manifest = readManifest(row.manifest, `${path}.manifest`);
  const status = expectEnum(row.status, ["proposed", "accepted", "rejected"] as const, `${path}.status`);
  const receipt = row.receipt === undefined ? undefined : readReceipt(row.receipt, `${path}.receipt`);
  if (receipt && (status !== "accepted" || receipt.digest !== manifest.digest)) {
    throw new RemoteProtocolError("invalid_field", "Artifact receipt is outside the accepted offer", `${path}.receipt`);
  }
  return { manifest, signature: expectEs256Signature(row.signature, `${path}.signature`), status, ...(receipt ? { receipt } : {}) };
}

function readManifest(value: unknown, path: string): RemoteDeviceArtifactManifestV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, [
    "version", "gatewayId", "mobileDeviceId", "deviceEpoch", "workspaceId", "workspaceBindingId", "policyVersion",
    "shareId", "revision", "proposalId", "taskId", "projectionDigest", "ownerId", "targetDeviceId", "attemptId", "connectionRevision",
    "name", "sizeBytes", "digest", "chunkBytes", "expiresAt",
  ], [], path);
  const name = expectString(row.name, `${path}.name`, { minBytes: 1, maxBytes: 320 });
  if (!isRemoteDeviceArtifactName(name)) throw new RemoteProtocolError("invalid_field", "Artifact name is invalid", `${path}.name`);
  return {
    version: expectLiteral(row.version, 1, `${path}.version`),
    gatewayId: expectIdentifier(row.gatewayId, `${path}.gatewayId`),
    mobileDeviceId: expectIdentifier(row.mobileDeviceId, `${path}.mobileDeviceId`),
    deviceEpoch: expectSafeInteger(row.deviceEpoch, `${path}.deviceEpoch`, { minimum: 1 }),
    workspaceId: expectIdentifier(row.workspaceId, `${path}.workspaceId`),
    workspaceBindingId: expectIdentifier(row.workspaceBindingId, `${path}.workspaceBindingId`),
    policyVersion: expectSafeInteger(row.policyVersion, `${path}.policyVersion`, { minimum: 1 }),
    shareId: expectIdentifier(row.shareId, `${path}.shareId`),
    revision: expectSafeInteger(row.revision, `${path}.revision`, { minimum: 1 }),
    proposalId: expectIdentifier(row.proposalId, `${path}.proposalId`),
    taskId: expectIdentifier(row.taskId, `${path}.taskId`),
    projectionDigest: readDigest(row.projectionDigest, `${path}.projectionDigest`),
    ownerId: expectIdentifier(row.ownerId, `${path}.ownerId`),
    targetDeviceId: expectIdentifier(row.targetDeviceId, `${path}.targetDeviceId`),
    attemptId: expectJournalIdentifier(row.attemptId, `${path}.attemptId`),
    connectionRevision: expectIdentifier(row.connectionRevision, `${path}.connectionRevision`),
    name,
    sizeBytes: expectSafeInteger(row.sizeBytes, `${path}.sizeBytes`, { minimum: 1, maximum: REMOTE_DEVICE_ARTIFACT_MAX_BYTES }),
    chunkBytes: expectLiteral(row.chunkBytes, REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, `${path}.chunkBytes`),
    digest: readDigest(row.digest, `${path}.digest`),
    expiresAt: expectRfc3339(row.expiresAt, `${path}.expiresAt`),
  };
}

function readReceipt(value: unknown, path: string): RemoteDeviceArtifactReceiptV1 {
  const row = expectRecord(value, path);
  assertStrictKeys(row, ["digest", "verifiedAt", "signature"], [], path);
  return {
    digest: readDigest(row.digest, `${path}.digest`),
    verifiedAt: expectRfc3339(row.verifiedAt, `${path}.verifiedAt`),
    signature: expectEs256Signature(row.signature, `${path}.signature`),
  };
}

function readDigest(value: unknown, path: string): string {
  const digest = expectString(value, path, { minBytes: 71, maxBytes: 71 });
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new RemoteProtocolError("invalid_field", "Expected a SHA-256 digest", path);
  return digest;
}

function readIndex(value: unknown, path: string): number {
  return expectSafeInteger(value, path, { minimum: 0, maximum: chunkIndexMax });
}
