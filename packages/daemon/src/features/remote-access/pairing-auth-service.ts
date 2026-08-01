import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SIGNING_ALGORITHM,
  REMOTE_SUPPORTED_PROTOCOL_VERSIONS,
  type RemoteAuthChallengeV1,
  type RemoteAuthProofV1,
  type RemotePairingAcceptedV1,
  type RemotePairingChallengeV1,
  type RemotePairingProofV1,
  type RemotePairingQrV1,
  type RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import {
  authChallengeSigningBytes,
  authChallengeSigningInput,
  authProofSigningBytes,
  authProofSigningInput,
  decodeBase64Url,
  encodeBase64Url,
  encodePairingQrV1,
  fingerprintPublicJwkSync,
  hmacSha256,
  pairingAcceptedSigningBytes,
  pairingAcceptedSigningInput,
  pairingChallengeSigningBytes,
  pairingChallengeSigningInput,
  pairingProofSigningBytes,
  pairingProofSigningInput,
  sha256,
  validateRemoteAuthProofV1,
  validateRemotePairingProofV1,
} from "@ling-stack/remote-protocol";
import { RemoteAccessError } from "./errors.js";
import {
  type PairedRemoteDevice,
  type RemoteAccessPersistentState,
  type RemoteAccessStateStore,
  type RemoteGatewayIdentityRecord,
  normalizeGatewayOrigin,
} from "./state-store.js";

const PAIRING_LIFETIME_MS = 5 * 60_000;
const AUTH_CHALLENGE_LIFETIME_MS = 30_000;

interface PairingReservation {
  readonly pairingId: string;
  readonly pairingSecret: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly challenges: Map<string, PairingChallengeRecord>;
  pending?: PendingPairing;
}

interface PairingChallengeRecord {
  readonly challenge: RemotePairingChallengeV1;
  used: boolean;
}

interface PendingPairing {
  readonly proof: RemotePairingProofV1;
  readonly receivedAt: string;
  accepted?: RemotePairingAcceptedV1;
}

interface AuthChallengeRecord {
  readonly challenge: RemoteAuthChallengeV1;
  readonly deviceId: string;
}

export interface AuthenticatedRemoteSession {
  readonly sessionId: string;
  readonly device: PairedRemoteDevice;
  readonly resume: RemoteAuthProofV1["resume"];
  readonly authenticatedAt: string;
}

export interface PairingStatusView {
  readonly state: "idle" | "waiting_for_phone" | "awaiting_pc_confirmation" | "accepted";
  readonly pairingId?: string;
  readonly expiresAt?: string;
  readonly pendingDevice?: {
    readonly deviceId: string;
    readonly displayName: string;
    readonly platform: "ios" | "android";
    readonly publicKeyFingerprint: string;
  };
}

export interface RemotePairingAuthServiceOptions {
  readonly stateStore: RemoteAccessStateStore;
  readonly now?: () => string;
  readonly onSecurityStateChanged?: (reason: "disabled" | "revoked" | "paired") => void;
}

export class RemotePairingAuthService {
  private readonly now: () => string;
  private identityRecord?: RemoteGatewayIdentityRecord;
  private pairing?: PairingReservation;
  private readonly authChallenges = new Map<string, AuthChallengeRecord>();

  constructor(private readonly options: RemotePairingAuthServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get identity(): RemoteGatewayIdentityRecord {
    this.identityRecord ??= this.options.stateStore.readOrCreateIdentity();
    return this.identityRecord;
  }

  state(): RemoteAccessPersistentState {
    return this.options.stateStore.readState();
  }

  enable(gatewayOrigin: string): RemoteAccessPersistentState {
    const origin = normalizeGatewayOrigin(gatewayOrigin);
    return this.options.stateStore.updateState((current) => ({
      ...current,
      enabled: true,
      gatewayOrigin: origin,
      updatedAt: this.now(),
    }));
  }

  disable(): RemoteAccessPersistentState {
    this.pairing = undefined;
    this.authChallenges.clear();
    const state = this.options.stateStore.updateState((current) => ({
      ...current,
      enabled: false,
      updatedAt: this.now(),
    }));
    this.options.onSecurityStateChanged?.("disabled");
    return state;
  }

  revokeDevice(): RemoteAccessPersistentState {
    this.pairing = undefined;
    this.authChallenges.clear();
    const state = this.options.stateStore.updateState((current) => ({
      ...current,
      deviceEpoch: current.deviceEpoch + 1,
      policyVersion: current.policyVersion + 1,
      pairedDevice: undefined,
      updatedAt: this.now(),
    }));
    this.options.onSecurityStateChanged?.("revoked");
    return state;
  }

  beginPairing(): { readonly qr: RemotePairingQrV1; readonly encodedQr: string } {
    const state = this.requireEnabledState();
    if (state.pairedDevice) {
      throw new RemoteAccessError("device_already_paired", "Revoke the current phone before pairing another device.");
    }
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + PAIRING_LIFETIME_MS).toISOString();
    this.pairing = {
      pairingId: `pairing_${randomUUID()}`,
      pairingSecret: encodeBase64Url(randomBytes(32)),
      createdAt,
      expiresAt,
      challenges: new Map(),
    };
    const qr: RemotePairingQrV1 = {
      kind: "ling_remote_pairing",
      version: REMOTE_PROTOCOL_VERSION,
      gatewayId: this.identity.gatewayId,
      gatewayOrigin: state.gatewayOrigin!,
      gatewayIdentityPublicKeyJwk: this.identity.publicKeyJwk,
      gatewayIdentityFingerprint: this.identity.publicKeyFingerprint,
      pairingId: this.pairing.pairingId,
      pairingSecret: this.pairing.pairingSecret,
      expiresAt,
    };
    return { qr, encodedQr: encodePairingQrV1(qr) };
  }

  pairingStatus(): PairingStatusView {
    const pairing = this.currentPairing(false);
    if (!pairing) {
      return { state: "idle" };
    }
    if (pairing.pending?.accepted) {
      return {
        state: "accepted",
        pairingId: pairing.pairingId,
        expiresAt: pairing.expiresAt,
        pendingDevice: pendingDeviceView(pairing.pending.proof),
      };
    }
    if (pairing.pending) {
      return {
        state: "awaiting_pc_confirmation",
        pairingId: pairing.pairingId,
        expiresAt: pairing.expiresAt,
        pendingDevice: pendingDeviceView(pairing.pending.proof),
      };
    }
    return { state: "waiting_for_phone", pairingId: pairing.pairingId, expiresAt: pairing.expiresAt };
  }

  createPairingChallenge(pairingId: string): RemotePairingChallengeV1 {
    const pairing = this.requireCurrentPairing(pairingId);
    const issuedAt = this.now();
    const unsigned: Omit<RemotePairingChallengeV1, "gatewaySignature"> = {
      version: REMOTE_PROTOCOL_VERSION,
      gatewayId: this.identity.gatewayId,
      pairingId: pairing.pairingId,
      serverNonce: encodeBase64Url(randomBytes(32)),
      issuedAt,
      expiresAt: new Date(Math.min(Date.parse(issuedAt) + 60_000, Date.parse(pairing.expiresAt))).toISOString(),
    };
    const challenge: RemotePairingChallengeV1 = {
      ...unsigned,
      gatewaySignature: this.sign(pairingChallengeSigningBytes(pairingChallengeSigningInput(this.requireGatewayOrigin(), unsigned))),
    };
    pairing.challenges.set(challenge.serverNonce, { challenge, used: false });
    return challenge;
  }

  submitPairingProof(value: unknown):
    | { readonly status: "confirmation_required" }
    | { readonly status: "accepted"; readonly accepted: RemotePairingAcceptedV1 } {
    const proof = validateRemotePairingProofV1(value);
    const pairing = this.requireCurrentPairing(proof.pairingId);
    if (proof.gatewayId !== this.identity.gatewayId || proof.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      throw new RemoteAccessError("protocol_incompatible", "Pairing proof targets a different Gateway.");
    }
    if (pairing.pending) {
      if (!samePairingProof(pairing.pending.proof, proof)) {
        throw new RemoteAccessError("pairing_consumed", "This pairing reservation is already claimed.");
      }
      return pairing.pending.accepted
        ? { status: "accepted", accepted: pairing.pending.accepted }
        : { status: "confirmation_required" };
    }
    const challengeRecord = pairing.challenges.get(proof.serverNonce);
    if (!challengeRecord || challengeRecord.used || Date.parse(challengeRecord.challenge.expiresAt) < Date.parse(this.now())) {
      throw new RemoteAccessError("pairing_expired", "The pairing challenge is missing, used, or expired.");
    }
    challengeRecord.used = true;
    const signingInput = pairingProofSigningInput(this.requireGatewayOrigin(), omitPairingProofSignatures(proof));
    const signingBytes = pairingProofSigningBytes(signingInput);
    const expectedHmac = hmacSha256(decodeBase64Url(pairing.pairingSecret), signingBytes);
    if (!safeEqual(expectedHmac, decodeBase64Url(proof.pairingHmac))) {
      throw new RemoteAccessError("signature_invalid", "Pairing secret proof is invalid.");
    }
    if (!this.verifyDevice(proof.devicePublicKeyJwk, signingBytes, proof.deviceSignature)) {
      throw new RemoteAccessError("signature_invalid", "Device pairing signature is invalid.");
    }
    pairing.pending = { proof, receivedAt: this.now() };
    return { status: "confirmation_required" };
  }

  confirmPendingPairing(): RemotePairingAcceptedV1 {
    const state = this.requireEnabledState();
    const pairing = this.currentPairing(true);
    if (!pairing?.pending) {
      throw new RemoteAccessError("pairing_confirmation_required", "No phone is waiting for confirmation.");
    }
    if (state.pairedDevice) {
      throw new RemoteAccessError("device_already_paired", "A phone is already paired.");
    }
    if (pairing.pending.accepted) {
      return pairing.pending.accepted;
    }
    const pairedAt = this.now();
    const deviceEpoch = state.deviceEpoch + 1;
    const pairedDevice: PairedRemoteDevice = {
      deviceId: pairing.pending.proof.deviceId,
      displayName: pairing.pending.proof.displayName,
      platform: pairing.pending.proof.platform,
      publicKeyJwk: pairing.pending.proof.devicePublicKeyJwk,
      publicKeyFingerprint: pairing.pending.proof.devicePublicKeyFingerprint,
      deviceEpoch,
      pairedAt,
    };
    this.options.stateStore.updateState((current) => ({
      ...current,
      deviceEpoch,
      policyVersion: current.policyVersion + 1,
      pairedDevice,
      updatedAt: pairedAt,
    }));
    const unsigned: Omit<RemotePairingAcceptedV1, "gatewaySignature"> = {
      version: REMOTE_PROTOCOL_VERSION,
      gatewayId: this.identity.gatewayId,
      pairingId: pairing.pairingId,
      deviceId: pairedDevice.deviceId,
      deviceEpoch,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      pairedAt,
    };
    const accepted: RemotePairingAcceptedV1 = {
      ...unsigned,
      gatewaySignature: this.sign(pairingAcceptedSigningBytes(pairingAcceptedSigningInput(this.requireGatewayOrigin(), unsigned))),
    };
    pairing.pending.accepted = accepted;
    this.options.onSecurityStateChanged?.("paired");
    return accepted;
  }

  rejectPendingPairing(): void {
    if (!this.currentPairing(false)?.pending) {
      throw new RemoteAccessError("pairing_confirmation_required", "No phone is waiting for confirmation.");
    }
    this.pairing = undefined;
  }

  createAuthChallenge(deviceId: string): RemoteAuthChallengeV1 {
    const state = this.requireEnabledState();
    const device = state.pairedDevice;
    if (!device || device.deviceId !== deviceId) {
      throw new RemoteAccessError("device_revoked", "This device is not paired.");
    }
    const issuedAt = this.now();
    const unsigned: Omit<RemoteAuthChallengeV1, "gatewaySignature"> = {
      version: REMOTE_PROTOCOL_VERSION,
      gatewayId: this.identity.gatewayId,
      challengeId: `challenge_${randomUUID()}`,
      serverNonce: encodeBase64Url(randomBytes(32)),
      candidateSessionId: `session_${randomUUID()}`,
      deviceEpoch: device.deviceEpoch,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + AUTH_CHALLENGE_LIFETIME_MS).toISOString(),
      supportedProtocolVersions: REMOTE_SUPPORTED_PROTOCOL_VERSIONS,
    };
    const challenge: RemoteAuthChallengeV1 = {
      ...unsigned,
      gatewaySignature: this.sign(authChallengeSigningBytes(authChallengeSigningInput(this.requireGatewayOrigin(), unsigned))),
    };
    this.authChallenges.set(challenge.challengeId, { challenge, deviceId });
    return challenge;
  }

  async verifyAuthProof(value: unknown): Promise<AuthenticatedRemoteSession> {
    const proof = validateRemoteAuthProofV1(value);
    const record = this.authChallenges.get(proof.challengeId);
    this.authChallenges.delete(proof.challengeId);
    if (!record || Date.parse(record.challenge.expiresAt) < Date.parse(this.now())) {
      throw new RemoteAccessError("challenge_expired", "Authentication challenge is missing, used, or expired.");
    }
    const state = this.requireEnabledState();
    const device = state.pairedDevice;
    if (!device || device.deviceId !== proof.deviceId || record.deviceId !== proof.deviceId) {
      throw new RemoteAccessError("device_revoked", "This device is no longer paired.");
    }
    if (proof.deviceEpoch !== device.deviceEpoch || proof.deviceEpoch !== record.challenge.deviceEpoch) {
      throw new RemoteAccessError("device_epoch_mismatch", "The device epoch is stale.");
    }
    if (
      proof.gatewayId !== this.identity.gatewayId
      || proof.candidateSessionId !== record.challenge.candidateSessionId
      || proof.protocolVersion !== REMOTE_PROTOCOL_VERSION
    ) {
      throw new RemoteAccessError("protocol_incompatible", "Authentication proof does not match the challenge.");
    }
    const signingInput = await authProofSigningInput(
      this.requireGatewayOrigin(),
      omitGatewaySignature(record.challenge),
      omitAuthProofSignature(proof),
      sha256,
    );
    if (!this.verifyDevice(device.publicKeyJwk, authProofSigningBytes(signingInput), proof.signature)) {
      throw new RemoteAccessError("signature_invalid", "Device authentication signature is invalid.");
    }
    return {
      sessionId: proof.candidateSessionId,
      device,
      resume: proof.resume,
      authenticatedAt: this.now(),
    };
  }

  private requireEnabledState(): RemoteAccessPersistentState {
    const state = this.state();
    if (!state.enabled || !state.gatewayOrigin) {
      throw new RemoteAccessError("pc_unavailable", "Remote Access is disabled on this PC.", true);
    }
    return state;
  }

  private requireGatewayOrigin(): string {
    return this.requireEnabledState().gatewayOrigin!;
  }

  private currentPairing(throwIfExpired: boolean): PairingReservation | undefined {
    if (!this.pairing) {
      return undefined;
    }
    if (Date.parse(this.pairing.expiresAt) < Date.parse(this.now())) {
      this.pairing = undefined;
      if (throwIfExpired) {
        throw new RemoteAccessError("pairing_expired", "The pairing reservation expired.");
      }
      return undefined;
    }
    return this.pairing;
  }

  private requireCurrentPairing(pairingId: string): PairingReservation {
    const pairing = this.currentPairing(true);
    if (!pairing || pairing.pairingId !== pairingId) {
      throw new RemoteAccessError("pairing_closed", "Pairing is not open for this reservation.");
    }
    return pairing;
  }

  private sign(bytes: Uint8Array): string {
    return encodeBase64Url(sign("sha256", bytes, {
      key: this.identity.privateKeyPem,
      dsaEncoding: "ieee-p1363",
    }));
  }

  private verifyDevice(publicKeyJwk: RemoteP256PublicJwkV1, bytes: Uint8Array, encodedSignature: string): boolean {
    try {
      return verify("sha256", bytes, {
        key: createPublicKey({ key: publicKeyJwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]),
        dsaEncoding: "ieee-p1363",
      }, decodeBase64Url(encodedSignature));
    } catch {
      return false;
    }
  }
}

export function createRemoteGatewayIdentity(now: string): RemoteGatewayIdentityRecord {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyJwk = publicKey.export({ format: "jwk" }) as RemoteP256PublicJwkV1;
  return {
    version: 1,
    gatewayId: `gateway_${randomUUID()}`,
    algorithm: REMOTE_SIGNING_ALGORITHM,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyJwk,
    publicKeyFingerprint: fingerprintPublicJwkSync(publicKeyJwk),
    createdAt: now,
  };
}

function pendingDeviceView(proof: RemotePairingProofV1): NonNullable<PairingStatusView["pendingDevice"]> {
  return {
    deviceId: proof.deviceId,
    displayName: proof.displayName,
    platform: proof.platform,
    publicKeyFingerprint: proof.devicePublicKeyFingerprint,
  };
}

function omitPairingProofSignatures(
  proof: RemotePairingProofV1,
): Omit<RemotePairingProofV1, "pairingHmac" | "deviceSignature"> {
  const { pairingHmac: _pairingHmac, deviceSignature: _deviceSignature, ...unsigned } = proof;
  return unsigned;
}

function omitAuthProofSignature(proof: RemoteAuthProofV1): Omit<RemoteAuthProofV1, "signature"> {
  const { signature: _signature, ...unsigned } = proof;
  return unsigned;
}

function omitGatewaySignature(challenge: RemoteAuthChallengeV1): Omit<RemoteAuthChallengeV1, "gatewaySignature"> {
  const { gatewaySignature: _gatewaySignature, ...unsigned } = challenge;
  return unsigned;
}

function samePairingProof(left: RemotePairingProofV1, right: RemotePairingProofV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
