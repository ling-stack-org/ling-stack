import type {
  RemoteAuthChallengeV1,
  RemoteAuthProofV1,
  RemotePairingAcceptedV1,
  RemotePairingChallengeV1,
  RemotePairingProofV1,
  RemotePairingQrV1,
  RemoteP256PublicJwkV1,
  RemoteResumeCursorV1,
  RemoteSendTextCommandV1,
} from "@ling-stack/contracts";
import {
  canonicalJsonBytes,
  canonicalizeJson,
  decodeBase64Url,
  domainSeparatedCanonicalBytes,
  equalBytes,
  encodeBase64Url,
} from "./canonical.js";
import { RemoteProtocolError } from "./errors.js";
import { sha256 } from "./sha256.js";

export const REMOTE_SIGNING_DOMAINS_V1 = {
  pairingChallenge: "ling-remote-pair-challenge-v1",
  pairingProof: "ling-remote-pair-proof-v1",
  pairingAccepted: "ling-remote-pair-accepted-v1",
  authChallenge: "ling-remote-auth-challenge-v1",
  authProof: "ling-remote-auth-v1",
  command: "ling-remote-command-v1",
} as const;

export type RemoteSha256 = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface RemotePairingChallengeSigningInputV1 {
  readonly gatewayOrigin: string;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly serverNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly protocolVersion: 1;
}

export interface RemotePairingProofSigningInputV1 {
  readonly gatewayOrigin: string;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly serverNonce: string;
  readonly clientNonce: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly platform: "ios" | "android";
  readonly devicePublicKeyJwk: RemoteP256PublicJwkV1;
  readonly devicePublicKeyFingerprint: string;
  readonly protocolVersion: 1;
}

export interface RemotePairingAcceptedSigningInputV1 {
  readonly gatewayOrigin: string;
  readonly gatewayId: string;
  readonly pairingId: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly protocolVersion: 1;
  readonly pairedAt: string;
}

export interface RemoteAuthChallengeSigningInputV1 {
  readonly gatewayOrigin: string;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly candidateSessionId: string;
  readonly serverNonce: string;
  readonly deviceEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly supportedProtocolVersions: readonly [1];
}

export interface RemoteAuthProofSigningInputV1 {
  readonly gatewayOrigin: string;
  readonly gatewayId: string;
  readonly challengeId: string;
  readonly candidateSessionId: string;
  readonly serverNonce: string;
  readonly clientNonce: string;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly protocolVersion: 1;
  readonly resumeHash: string;
}

export interface RemoteCommandHashInputV1 {
  readonly gatewayId: string;
  readonly deviceEpoch: number;
  readonly commandKind: "conversation.send_text";
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly issuedAt: string;
  readonly retryUntil: string;
  readonly remotePolicyVersion: number;
}

export function canonicalPublicJwkBytes(jwk: RemoteP256PublicJwkV1): Uint8Array {
  return canonicalJsonBytes({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export async function fingerprintPublicJwk(
  jwk: RemoteP256PublicJwkV1,
  sha256: RemoteSha256,
): Promise<string> {
  return encodeBase64Url(await sha256(canonicalPublicJwkBytes(jwk)));
}

export function fingerprintPublicJwkSync(jwk: RemoteP256PublicJwkV1): string {
  return encodeBase64Url(sha256(canonicalPublicJwkBytes(jwk)));
}

export function matchesPublicJwkFingerprint(
  jwk: RemoteP256PublicJwkV1,
  declaredFingerprint: string,
): boolean {
  try {
    return equalBytes(
      decodeBase64Url(fingerprintPublicJwkSync(jwk)),
      decodeBase64Url(declaredFingerprint),
    );
  } catch {
    return false;
  }
}

export function encodePairingQrV1(qr: RemotePairingQrV1): string {
  return `ling-pair-v1:${encodeBase64Url(canonicalJsonBytes(qr))}`;
}

export function pairingChallengeSigningBytes(input: RemotePairingChallengeSigningInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.pairingChallenge, input);
}

export function pairingProofSigningBytes(input: RemotePairingProofSigningInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.pairingProof, input);
}

export function pairingAcceptedSigningBytes(input: RemotePairingAcceptedSigningInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.pairingAccepted, input);
}

export function authChallengeSigningBytes(input: RemoteAuthChallengeSigningInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.authChallenge, input);
}

export function authProofSigningBytes(input: RemoteAuthProofSigningInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.authProof, input);
}

export function commandHashBytes(input: RemoteCommandHashInputV1): Uint8Array {
  return domainSeparatedCanonicalBytes(REMOTE_SIGNING_DOMAINS_V1.command, input);
}

export function assertUniqueResumeStreamIds(
  resume: readonly RemoteResumeCursorV1[],
  path = "$resume",
): void {
  const streamIds = new Set<string>();
  for (const cursor of resume) {
    if (streamIds.has(cursor.streamId)) {
      throw new RemoteProtocolError("invalid_field", "Resume cursors cannot repeat a stream", path);
    }
    streamIds.add(cursor.streamId);
  }
}

export function canonicalResumeCursors(resume: readonly RemoteResumeCursorV1[]): readonly RemoteResumeCursorV1[] {
  assertUniqueResumeStreamIds(resume);
  return [...resume].sort((left, right) => {
    const byStream = left.streamId < right.streamId ? -1 : left.streamId > right.streamId ? 1 : 0;
    return byStream !== 0
      ? byStream
      : left.snapshotId < right.snapshotId
        ? -1
        : left.snapshotId > right.snapshotId
          ? 1
          : 0;
  });
}

export async function hashResumeCursors(
  resume: readonly RemoteResumeCursorV1[],
  sha256: RemoteSha256,
): Promise<string> {
  return encodeBase64Url(await sha256(canonicalJsonBytes(canonicalResumeCursors(resume))));
}

export function pairingChallengeSigningInput(
  gatewayOrigin: string,
  challenge: Omit<RemotePairingChallengeV1, "gatewaySignature">,
): RemotePairingChallengeSigningInputV1 {
  return {
    gatewayOrigin,
    gatewayId: challenge.gatewayId,
    pairingId: challenge.pairingId,
    serverNonce: challenge.serverNonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    protocolVersion: 1,
  };
}

export function pairingProofSigningInput(
  gatewayOrigin: string,
  proof: Omit<RemotePairingProofV1, "pairingHmac" | "deviceSignature">,
): RemotePairingProofSigningInputV1 {
  return {
    gatewayOrigin,
    gatewayId: proof.gatewayId,
    pairingId: proof.pairingId,
    serverNonce: proof.serverNonce,
    clientNonce: proof.clientNonce,
    deviceId: proof.deviceId,
    displayName: proof.displayName,
    platform: proof.platform,
    devicePublicKeyJwk: proof.devicePublicKeyJwk,
    devicePublicKeyFingerprint: proof.devicePublicKeyFingerprint,
    protocolVersion: proof.protocolVersion,
  };
}

export function pairingAcceptedSigningInput(
  gatewayOrigin: string,
  accepted: Omit<RemotePairingAcceptedV1, "gatewaySignature">,
): RemotePairingAcceptedSigningInputV1 {
  return {
    gatewayOrigin,
    gatewayId: accepted.gatewayId,
    pairingId: accepted.pairingId,
    deviceId: accepted.deviceId,
    deviceEpoch: accepted.deviceEpoch,
    protocolVersion: accepted.protocolVersion,
    pairedAt: accepted.pairedAt,
  };
}

export function authChallengeSigningInput(
  gatewayOrigin: string,
  challenge: Omit<RemoteAuthChallengeV1, "gatewaySignature">,
): RemoteAuthChallengeSigningInputV1 {
  return {
    gatewayOrigin,
    gatewayId: challenge.gatewayId,
    challengeId: challenge.challengeId,
    candidateSessionId: challenge.candidateSessionId,
    serverNonce: challenge.serverNonce,
    deviceEpoch: challenge.deviceEpoch,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    supportedProtocolVersions: challenge.supportedProtocolVersions,
  };
}

export async function authProofSigningInput(
  gatewayOrigin: string,
  challenge: Omit<RemoteAuthChallengeV1, "gatewaySignature">,
  proof: Omit<RemoteAuthProofV1, "signature">,
  sha256: RemoteSha256,
): Promise<RemoteAuthProofSigningInputV1> {
  return {
    gatewayOrigin,
    gatewayId: proof.gatewayId,
    challengeId: proof.challengeId,
    candidateSessionId: proof.candidateSessionId,
    serverNonce: challenge.serverNonce,
    clientNonce: proof.clientNonce,
    deviceId: proof.deviceId,
    deviceEpoch: proof.deviceEpoch,
    protocolVersion: proof.protocolVersion,
    resumeHash: await hashResumeCursors(proof.resume, sha256),
  };
}

export function commandHashInput(
  gatewayId: string,
  deviceEpoch: number,
  command: RemoteSendTextCommandV1,
  remotePolicyVersion: number,
): RemoteCommandHashInputV1 {
  return {
    gatewayId,
    deviceEpoch,
    commandKind: "conversation.send_text",
    workspaceId: command.workspaceId,
    conversationId: command.conversationId,
    body: command.body,
    issuedAt: command.issuedAt,
    retryUntil: command.retryUntil,
    remotePolicyVersion,
  };
}

export function canonicalFixtureText(value: unknown): string {
  return canonicalizeJson(value);
}
