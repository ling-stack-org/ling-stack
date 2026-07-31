import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RemoteConversationAccessV1,
  RemoteMobilePlatformV1,
  RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import { fingerprintPublicJwkSync, validateRemoteP256PublicJwkV1 } from "@ling-stack/remote-protocol";

export interface PairedRemoteDevice {
  readonly deviceId: string;
  readonly displayName: string;
  readonly platform: RemoteMobilePlatformV1;
  readonly publicKeyJwk: RemoteP256PublicJwkV1;
  readonly publicKeyFingerprint: string;
  readonly deviceEpoch: number;
  readonly pairedAt: string;
}

export interface RemoteAccessPersistentState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly gatewayOrigin?: string;
  readonly listenerPort: number;
  readonly deviceEpoch: number;
  readonly policyVersion: number;
  readonly workspaceBindingId: string;
  readonly conversationAccess: RemoteConversationAccessV1;
  readonly pairedDevice?: PairedRemoteDevice;
  readonly updatedAt: string;
}

export interface RemoteGatewayIdentityRecord {
  readonly version: 1;
  readonly gatewayId: string;
  readonly algorithm: "ES256";
  readonly privateKeyPem: string;
  readonly publicKeyJwk: RemoteP256PublicJwkV1;
  readonly publicKeyFingerprint: string;
  readonly createdAt: string;
}

export interface RemoteAccessStateStoreOptions {
  readonly stateDir: string;
  readonly listenerPort: number;
  readonly createIdentity: (now: string) => RemoteGatewayIdentityRecord;
  readonly now?: () => string;
}

export class RemoteAccessStateStore {
  readonly statePath: string;
  readonly identityPath: string;
  private readonly now: () => string;

  constructor(private readonly options: RemoteAccessStateStoreOptions) {
    this.statePath = join(options.stateDir, "remote-access.json");
    this.identityPath = join(options.stateDir, "remote-gateway-identity.json");
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  }

  hasState(): boolean {
    return existsSync(this.statePath);
  }

  readState(): RemoteAccessPersistentState {
    if (!existsSync(this.statePath)) {
      const initial: RemoteAccessPersistentState = {
        version: 1,
        enabled: false,
        listenerPort: this.options.listenerPort,
        deviceEpoch: 0,
        policyVersion: 1,
        workspaceBindingId: `workspace_binding_${randomUUID()}`,
        conversationAccess: {
          mode: "all_in_workspace",
          kinds: ["channel", "conversation", "teammate_direct"],
        },
        updatedAt: this.now(),
      };
      this.writeState(initial);
      return initial;
    }
    return parsePersistentState(readJsonFile(this.statePath));
  }

  writeState(state: RemoteAccessPersistentState): void {
    writePrivateJson(this.statePath, state);
  }

  updateState(update: (current: RemoteAccessPersistentState) => RemoteAccessPersistentState): RemoteAccessPersistentState {
    const next = parsePersistentState(update(this.readState()));
    this.writeState(next);
    return next;
  }

  readOrCreateIdentity(): RemoteGatewayIdentityRecord {
    if (existsSync(this.identityPath)) {
      return parseIdentity(readJsonFile(this.identityPath));
    }
    const identity = parseIdentity(this.options.createIdentity(this.now()));
    writePrivateJson(this.identityPath, identity);
    return identity;
  }

  destroyForTests(): void {
    rmSync(this.statePath, { force: true });
    rmSync(this.identityPath, { force: true });
  }
}

function parsePersistentState(value: unknown): RemoteAccessPersistentState {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("Remote access state is invalid");
  }
  const listenerPort = expectInteger(value.listenerPort, "listenerPort", 1, 65_535);
  const deviceEpoch = expectInteger(value.deviceEpoch, "deviceEpoch", 0);
  const policyVersion = expectInteger(value.policyVersion, "policyVersion", 1);
  const workspaceBindingId = expectString(value.workspaceBindingId, "workspaceBindingId");
  const updatedAt = expectTimestamp(value.updatedAt, "updatedAt");
  const gatewayOrigin = value.gatewayOrigin === undefined ? undefined : normalizeGatewayOrigin(expectString(value.gatewayOrigin, "gatewayOrigin"));
  const conversationAccess = parseConversationAccess(value.conversationAccess);
  const pairedDevice = value.pairedDevice === undefined ? undefined : parsePairedDevice(value.pairedDevice);
  if (pairedDevice && pairedDevice.deviceEpoch !== deviceEpoch) {
    throw new Error("Remote paired-device epoch does not match state");
  }
  return {
    version: 1,
    enabled: value.enabled,
    ...(gatewayOrigin ? { gatewayOrigin } : {}),
    listenerPort,
    deviceEpoch,
    policyVersion,
    workspaceBindingId,
    conversationAccess,
    ...(pairedDevice ? { pairedDevice } : {}),
    updatedAt,
  };
}

function parseIdentity(value: unknown): RemoteGatewayIdentityRecord {
  if (!isRecord(value) || value.version !== 1 || value.algorithm !== "ES256") {
    throw new Error("Remote Gateway identity is invalid");
  }
  const publicKeyJwk = validateRemoteP256PublicJwkV1(value.publicKeyJwk);
  const publicKeyFingerprint = expectString(value.publicKeyFingerprint, "publicKeyFingerprint");
  if (fingerprintPublicJwkSync(publicKeyJwk) !== publicKeyFingerprint) {
    throw new Error("Remote Gateway identity fingerprint does not match its public key");
  }
  const privateKeyPem = expectString(value.privateKeyPem, "privateKeyPem");
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("Remote Gateway private key is invalid");
  }
  return {
    version: 1,
    gatewayId: expectString(value.gatewayId, "gatewayId"),
    algorithm: "ES256",
    privateKeyPem,
    publicKeyJwk,
    publicKeyFingerprint,
    createdAt: expectTimestamp(value.createdAt, "createdAt"),
  };
}

function parsePairedDevice(value: unknown): PairedRemoteDevice {
  if (!isRecord(value) || (value.platform !== "ios" && value.platform !== "android")) {
    throw new Error("Remote paired device is invalid");
  }
  const publicKeyJwk = validateRemoteP256PublicJwkV1(value.publicKeyJwk);
  const publicKeyFingerprint = expectString(value.publicKeyFingerprint, "publicKeyFingerprint");
  if (fingerprintPublicJwkSync(publicKeyJwk) !== publicKeyFingerprint) {
    throw new Error("Remote paired-device fingerprint does not match its public key");
  }
  return {
    deviceId: expectString(value.deviceId, "deviceId"),
    displayName: expectString(value.displayName, "displayName"),
    platform: value.platform,
    publicKeyJwk,
    publicKeyFingerprint,
    deviceEpoch: expectInteger(value.deviceEpoch, "deviceEpoch", 1),
    pairedAt: expectTimestamp(value.pairedAt, "pairedAt"),
  };
}

function parseConversationAccess(value: unknown): RemoteConversationAccessV1 {
  if (!isRecord(value)) {
    throw new Error("Remote conversation access is invalid");
  }
  if (value.mode === "selected" && Array.isArray(value.conversationIds) && value.conversationIds.every((item) => typeof item === "string")) {
    return { mode: "selected", conversationIds: [...new Set(value.conversationIds)] };
  }
  const kinds = value.kinds;
  if (
    value.mode === "all_in_workspace"
    && Array.isArray(kinds)
    && kinds.every((item) => item === "channel" || item === "conversation" || item === "teammate_direct")
  ) {
    return { mode: "all_in_workspace", kinds: [...new Set(kinds)] };
  }
  throw new Error("Remote conversation access is invalid");
}

export function normalizeGatewayOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("gatewayOrigin must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("gatewayOrigin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function writePrivateJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Remote access ${field} is invalid`);
  }
  return value;
}

function expectInteger(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Remote access ${field} is invalid`);
  }
  return value;
}

function expectTimestamp(value: unknown, field: string): string {
  const timestamp = expectString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Remote access ${field} is invalid`);
  }
  return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
