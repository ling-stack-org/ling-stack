import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  REMOTE_PROTOCOL_LIMITS, REMOTE_PROTOCOL_VERSION,
  type LingServerPairingIdentityV1,
  type LingServerPairingMigrationProposalV1,
  type LingServerPairingMigrationV1,
  type LingServerRoutingProfileV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { RemoteCommandReceipt } from "./remote-access-types.js";
import type { SqliteLingServerStore } from "./storage/sqlite/ling-server-store.js";

const confirmationLifetimeMs = 5 * 60_000;
const maxRetainedReceipts = 128;

type ConfirmedMigration = Extract<LingServerPairingMigrationV1, { status: "confirmed" }>;
type UnsignedConfirmation = Omit<ConfirmedMigration, "status" | "gatewaySignature">;

/** Records a local Gateway decision against its current pairing and command journal. */
export class LingServerPairingMigrationJournal {
  constructor(private readonly options: {
    readonly store: SqliteLingServerStore;
    readonly readReceipt: (commandId: string) => Pick<RemoteCommandReceipt, "commandId" | "deviceId" | "workspaceId" | "bodyHash"> | undefined;
    readonly now: () => string;
  }) {}

  prepare(
    value: unknown,
    oldPairing: LingServerPairingIdentityV1,
    workspaceId: string,
  ): LingServerPairingMigrationV1 {
    const request = exactRecord(value, ["routingProfile", "retainedCommandIds"]);
    const routingProfile = readRoutingProfile(request.routingProfile);
    const ids = request.retainedCommandIds;
    if (!Array.isArray(ids) || ids.length > maxRetainedReceipts || !ids.every(isIdentifier)
      || new Set(ids).size !== ids.length) {
      throw new DeviceFabricError("invalid_graph", "retained command ids are invalid");
    }
    return this.options.store.withWriteTransaction(() => {
      const createdAt = this.options.now();
      const proposal = {
        schemaVersion: 1 as const,
        migrationId: randomUUID(),
        oldPairing,
        routingProfile,
        retainedReceipts: this.readRetainedReceipts([...ids].sort(), oldPairing.mobileDeviceId, workspaceId),
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + confirmationLifetimeMs).toISOString(),
      };
      const confirmationDigest = createHash("sha256").update(JSON.stringify(["ling.server.pairing_migration.v1", proposal])).digest("hex");
      const pending = { ...proposal, confirmationDigest, status: "pending" as const };
      this.options.store.savePairingMigration(pending);
      return pending;
    });
  }

  confirm(
    value: unknown,
    currentPairing: LingServerPairingIdentityV1,
    workspaceId: string,
    sign: (confirmation: UnsignedConfirmation) => string,
  ): ConfirmedMigration {
    const request = exactRecord(value, ["migrationId", "confirmationDigest"]);
    const { migrationId, confirmationDigest } = request;
    if (!isIdentifier(migrationId) || typeof confirmationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(confirmationDigest)) {
      throw new DeviceFabricError("invalid_graph", "pairing migration confirmation is invalid");
    }
    return this.options.store.withWriteTransaction(() => {
      const migration = this.options.store.getPairingMigration(migrationId);
      if (!migration || migration.confirmationDigest !== confirmationDigest || !isDeepStrictEqual(migration.oldPairing, currentPairing)) {
        throw new DeviceFabricError("safety_denied", "pairing migration confirmation does not match the active pairing and proposal");
      }
      if (migration.status === "confirmed") return migration;
      const confirmedAt = this.options.now();
      if (!(Date.parse(migration.createdAt) <= Date.parse(confirmedAt) && Date.parse(confirmedAt) < Date.parse(migration.expiresAt))) {
        throw new DeviceFabricError("safety_denied", "pairing migration confirmation has expired");
      }
      const retainedReceipts = this.readRetainedReceipts(
        migration.retainedReceipts.map(receipt => receipt.commandId), currentPairing.mobileDeviceId, workspaceId,
      );
      if (!isDeepStrictEqual(migration.retainedReceipts, retainedReceipts)) {
        throw new DeviceFabricError("revision_conflict", "pairing migration retained receipts have changed");
      }
      const { status: _status, ...proposal } = migration;
      const unsigned = { ...proposal, confirmedAt };
      const confirmed: ConfirmedMigration = { ...unsigned, status: "confirmed", gatewaySignature: sign(unsigned) };
      this.options.store.savePairingMigration(confirmed);
      return confirmed;
    });
  }

  private readRetainedReceipts(
    ids: readonly string[], deviceId: string, workspaceId: string,
  ): LingServerPairingMigrationProposalV1["retainedReceipts"] {
    return ids.map(commandId => {
      const receipt = this.options.readReceipt(commandId);
      if (!receipt || receipt.commandId !== commandId || receipt.deviceId !== deviceId || receipt.workspaceId !== workspaceId) {
        throw new DeviceFabricError("target_missing", "pairing migration receipt is unavailable for the active pairing");
      }
      return { commandId, payloadDigest: receipt.bodyHash };
    });
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || !value || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new DeviceFabricError("invalid_graph", "pairing migration fields are invalid");
  }
  return value as Record<string, unknown>;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function readRoutingProfile(value: unknown): LingServerRoutingProfileV1 {
  const profile = exactRecord(value, [
    "schemaVersion", "bindingId", "installationId", "installationRevision", "serverOrigin",
    "applicationKeyFingerprint", "signalingProtocolMajor", "gatewayProtocolMajor",
  ]);
  const { bindingId, installationId, installationRevision, serverOrigin, applicationKeyFingerprint } = profile;
  const url = typeof serverOrigin === "string" && serverOrigin.length <= REMOTE_PROTOCOL_LIMITS.maxOriginBytes
    ? URL.parse(serverOrigin)
    : null;
  if (profile.schemaVersion !== 1 || !isIdentifier(bindingId) || !isIdentifier(installationId)
    || typeof installationRevision !== "number" || !Number.isSafeInteger(installationRevision) || installationRevision < 1
    || typeof serverOrigin !== "string" || url?.protocol !== "https:" || url.origin !== serverOrigin.replace(/\/$/u, "")
    || typeof applicationKeyFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(applicationKeyFingerprint)
    || Buffer.from(applicationKeyFingerprint, "base64url").toString("base64url") !== applicationKeyFingerprint
    || profile.signalingProtocolMajor !== 1 || profile.gatewayProtocolMajor !== REMOTE_PROTOCOL_VERSION) {
    throw new DeviceFabricError("invalid_graph", "Ling Server routing profile is incompatible or invalid");
  }
  return {
    schemaVersion: 1, bindingId, installationId, installationRevision, serverOrigin: url.origin, applicationKeyFingerprint,
    signalingProtocolMajor: 1, gatewayProtocolMajor: REMOTE_PROTOCOL_VERSION,
  };
}
