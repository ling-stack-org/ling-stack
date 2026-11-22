import { isDeepStrictEqual } from "node:util";
import {
  LING_SERVER_PEER_FRAME_DEFAULT_BYTES_V1,
  LING_SERVER_PEER_FRAME_MAX_BYTES_V1,
  type LingServerCommandReceiptV1,
  type LingServerConfirmedPairingMigrationV1,
  type LingServerInstallationV1,
  type LingServerPairingMigrationPublicationV1,
  type LingServerPeerBindingV1,
  type LingServerPeerFrameV1,
  type LingServerPeerResumeCursorV1,
  type LingServerPeerRoleV1,
  type LingServerPeerSessionV1,
  type LingServerRouteAttemptV1,
  type LingServerRoutingProfileV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { SqliteLingServerStore } from "./storage/sqlite/ling-server-store.js";

export interface LingServerPeerRegistryOptions {
  readonly store?: SqliteLingServerStore;
}

export class LingServerPeerRegistry {
  readonly #installations = new Map<string, LingServerInstallationV1>();
  readonly #bindings = new Map<string, LingServerPeerBindingV1>();
  readonly #routes = new Map<string, LingServerRouteAttemptV1>();
  readonly #pairingPublications = new Map<string, LingServerPairingMigrationPublicationV1>();

  readonly #store?: SqliteLingServerStore;

  constructor(options: LingServerPeerRegistryOptions = {}) {
    this.#store = options.store;
  }

  getInstallation(installationId: string): LingServerInstallationV1 | undefined {
    return this.#store ? this.#store.getInstallation(installationId) : this.#installations.get(installationId);
  }

  getBinding(bindingId: string): LingServerPeerBindingV1 | undefined {
    return this.#store ? this.#store.getBinding(bindingId) : this.#bindings.get(bindingId);
  }

  getRoute(routeAttemptId: string): LingServerRouteAttemptV1 | undefined {
    return this.#store ? this.#store.getRoute(routeAttemptId) : this.#routes.get(routeAttemptId);
  }

  registerInstallation(installation: LingServerInstallationV1): LingServerInstallationV1 {
    if (!/^https:\/\//u.test(installation.serverOrigin)) throw new DeviceFabricError("invalid_graph", "Ling Server origin must use HTTPS");
    return this.write(() => {
      const current = this.getInstallation(installation.installationId);
      if (!Number.isSafeInteger(installation.revision) || installation.revision <= (current?.revision ?? 0)) {
        throw new DeviceFabricError("revision_conflict", "Ling Server installation revision must advance");
      }
      if (this.#store) this.#store.saveInstallation(installation);
      else this.#installations.set(installation.installationId, installation);
      return installation;
    });
  }

  bindPeers(binding: LingServerPeerBindingV1): LingServerPeerBindingV1 {
    return this.write(() => this.bindPeerRevision(binding));
  }

  publishPairingMigration(confirmation: LingServerConfirmedPairingMigrationV1, now: string): LingServerPairingMigrationPublicationV1 {
    return this.write(() => {
      const { migrationId, routingProfile: profile, oldPairing } = confirmation;
      this.assertPairingInstallation(profile);
      const binding = this.getBinding(profile.bindingId);
      const prior = this.getPairingPublication(migrationId);
      if (prior) {
        if (!isDeepStrictEqual(prior.confirmation, confirmation) || !isDeepStrictEqual(prior.binding, binding)) {
          throw new DeviceFabricError("revision_conflict", "published pairing or its active binding changed");
        }
        return prior;
      }
      const admittedAt = Date.parse(now);
      if (!(Date.parse(confirmation.confirmedAt) <= admittedAt && admittedAt < Date.parse(confirmation.expiresAt))) {
        throw new DeviceFabricError("safety_denied", "pairing migration publication window expired");
      }
      if (binding) throw new DeviceFabricError("revision_conflict", "pairing migration binding id is in use");
      const publishedBinding = this.bindPeerRevision({
        bindingId: profile.bindingId, installationId: profile.installationId,
        gatewayId: oldPairing.gatewayId, mobileDeviceId: oldPairing.mobileDeviceId,
        gatewayKeyFingerprint: oldPairing.gatewayKeyFingerprint, mobileKeyFingerprint: oldPairing.mobileKeyFingerprint,
        epoch: oldPairing.deviceEpoch, revision: 1, status: "active",
      });
      const publication = { confirmation, binding: publishedBinding, publishedAt: now };
      if (this.#store) this.#store.savePairingPublication(publication);
      else this.#pairingPublications.set(migrationId, publication);
      return publication;
    });
  }

  requireActivePairingPublication(migrationId: string, confirmationDigest: string): LingServerPairingMigrationPublicationV1 {
    const publication = this.getPairingPublication(migrationId);
    if (!publication || publication.confirmation.confirmationDigest !== confirmationDigest) {
      throw new DeviceFabricError("safety_denied", "pairing migration publication is unavailable");
    }
    const { routingProfile } = publication.confirmation;
    this.assertPairingInstallation(routingProfile);
    const binding = this.requireActiveBinding(routingProfile.bindingId, publication.binding.epoch);
    if (!isDeepStrictEqual(publication.binding, binding)) {
      throw new DeviceFabricError("safety_denied", "published pairing binding changed");
    }
    return publication;
  }

  revokeBinding(bindingId: string, revision: number): LingServerPeerBindingV1 {
    return this.write(() => {
      const binding = this.getBinding(bindingId);
      if (!binding) throw new DeviceFabricError("target_missing", "peer binding is missing");
      if (binding.status === "revoked" && revision === binding.revision) return binding;
      if (!Number.isSafeInteger(revision) || revision <= binding.revision || !Number.isSafeInteger(binding.epoch + 1)) {
        throw new DeviceFabricError("revision_conflict", "peer revocation revision must advance");
      }
      const revoked = { ...binding, status: "revoked" as const, epoch: binding.epoch + 1, revision };
      this.saveBinding(revoked);
      return revoked;
    });
  }

  beginRoute(route: LingServerRouteAttemptV1): LingServerRouteAttemptV1 {
    return this.write(() => {
      const binding = this.requireActiveBinding(route.bindingId, route.peerEpoch);
      if (!["gathering", "checking"].includes(route.status) || route.selected !== undefined || !Number.isFinite(Date.parse(route.expiresAt))) {
        throw new DeviceFabricError("invalid_graph", "new route attempt is invalid");
      }
      const boundRoute = { ...route, peerEpoch: binding.epoch };
      const current = this.getRoute(route.routeAttemptId);
      if (current && !isDeepStrictEqual({ ...current, peerEpoch: current.peerEpoch ?? 1 }, boundRoute)) {
        throw new DeviceFabricError("revision_conflict", "route attempt id already has a binding or state");
      }
      if (current) return current;
      this.saveRoute(boundRoute);
      return boundRoute;
    });
  }

  selectRoute(routeAttemptId: string, selected: "lan" | "direct" | "relay", now: string): LingServerRouteAttemptV1 {
    return this.write(() => {
      const route = this.requireRoute(routeAttemptId);
      if (Date.parse(route.expiresAt) <= Date.parse(now) || route.status === "expired" || route.status === "failed") {
        throw new DeviceFabricError("safety_denied", "route attempt is unavailable");
      }
      if (!["lan", "direct", "relay"].includes(selected)) throw new DeviceFabricError("invalid_graph", "route kind is invalid");
      const next = { ...route, selected, status: "connected" as const };
      this.saveRoute(next);
      return next;
    });
  }

  failoverRoute(routeAttemptId: string, now: string): LingServerRouteAttemptV1 {
    return this.write(() => {
      const route = this.requireRoute(routeAttemptId);
      if (route.status === "expired" || route.status === "failed") return route;
      const { selected, ...attempt } = route;
      const next = Date.parse(route.expiresAt) <= Date.parse(now)
        ? { ...attempt, status: "expired" as const }
        : (selected ?? route.preferred) === "relay"
          ? { ...attempt, status: "failed" as const }
          : { ...attempt, preferred: "relay" as const, status: "checking" as const };
      this.saveRoute(next);
      return next;
    });
  }

  requireActiveBinding(bindingId: string, epoch?: number): LingServerPeerBindingV1 {
    const binding = this.getBinding(bindingId);
    if (!binding || binding.status !== "active" || (epoch !== undefined && binding.epoch !== epoch)
      || this.getInstallation(binding.installationId)?.status !== "active") {
      throw new DeviceFabricError("safety_denied", "peer binding is not active for this epoch");
    }
    return binding;
  }

  requireRoute(routeAttemptId: string): LingServerRouteAttemptV1 {
    const route = this.getRoute(routeAttemptId);
    if (!route) throw new DeviceFabricError("target_missing", "route attempt is missing");
    this.requireActiveBinding(route.bindingId, route.peerEpoch ?? 1);
    return route;
  }

  private getPairingPublication(migrationId: string): LingServerPairingMigrationPublicationV1 | undefined {
    return this.#store ? this.#store.getPairingPublication(migrationId) : this.#pairingPublications.get(migrationId);
  }

  private assertPairingInstallation(profile: LingServerRoutingProfileV1): void {
    const installation = this.getInstallation(profile.installationId);
    if (installation?.status !== "active" || installation.revision !== profile.installationRevision
      || installation.serverOrigin !== profile.serverOrigin || installation.applicationKeyFingerprint !== profile.applicationKeyFingerprint) {
      throw new DeviceFabricError("safety_denied", "pairing migration is outside the active installation");
    }
  }

  private bindPeerRevision(binding: LingServerPeerBindingV1): LingServerPeerBindingV1 {
    if (this.getInstallation(binding.installationId)?.status !== "active") {
      throw new DeviceFabricError("target_missing", "Ling Server installation is unavailable");
    }
    const current = this.getBinding(binding.bindingId);
    if (!Number.isSafeInteger(binding.revision) || binding.revision <= (current?.revision ?? 0)
      || !Number.isSafeInteger(binding.epoch) || binding.epoch < (current?.epoch ?? 1)) {
      throw new DeviceFabricError("revision_conflict", "peer binding revision or epoch regressed");
    }
    if (current && binding.epoch === current.epoch && (
      binding.status !== current.status || binding.installationId !== current.installationId
      || binding.gatewayId !== current.gatewayId || binding.mobileDeviceId !== current.mobileDeviceId
      || binding.gatewayKeyFingerprint !== current.gatewayKeyFingerprint || binding.mobileKeyFingerprint !== current.mobileKeyFingerprint
    )) {
      throw new DeviceFabricError("revision_conflict", "peer authority changes require a new epoch");
    }
    const knownBindings = this.#store?.listBindings() ?? [...this.#bindings.values()];
    if (binding.status === "active" && knownBindings.some(item =>
      item.bindingId !== binding.bindingId && item.gatewayId === binding.gatewayId && item.status === "active")) {
      throw new DeviceFabricError("revision_conflict", "gateway already has an active peer binding");
    }
    this.saveBinding(binding);
    return binding;
  }

  private saveBinding(binding: LingServerPeerBindingV1): void {
    if (this.#store) this.#store.saveBinding(binding);
    else this.#bindings.set(binding.bindingId, binding);
  }

  private saveRoute(route: LingServerRouteAttemptV1): void {
    if (this.#store) this.#store.saveRoute(route);
    else this.#routes.set(route.routeAttemptId, route);
  }

  private write<T>(work: () => T): T {
    return this.#store ? this.#store.withWriteTransaction(work) : work();
  }
}

export class LingServerPeerSessionCoordinator {
  readonly #store?: SqliteLingServerStore;
  readonly #registry: LingServerPeerRegistry;
  readonly #role: LingServerPeerRoleV1;
  readonly #maxFrameBytes: number;
  readonly #sessions = new Map<string, LingServerPeerSessionV1>();
  readonly #frames = new Map<string, LingServerPeerFrameV1>();
  readonly #receipts = new Map<string, LingServerCommandReceiptV1>();
  readonly #now: () => string;

  constructor(options: {
    readonly store?: SqliteLingServerStore;
    readonly registry?: LingServerPeerRegistry;
    readonly role?: LingServerPeerRoleV1;
    readonly maxFrameBytes?: number;
    readonly now?: () => string;
  } = {}) {
    this.#store = options.store;
    this.#registry = options.registry ?? new LingServerPeerRegistry({ store: this.#store });
    this.#role = options.role ?? "gateway";
    this.#maxFrameBytes = options.maxFrameBytes ?? LING_SERVER_PEER_FRAME_DEFAULT_BYTES_V1;
    if (!Number.isInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1024 || this.#maxFrameBytes > LING_SERVER_PEER_FRAME_MAX_BYTES_V1) {
      throw new DeviceFabricError("revision_conflict", "peer frame limit is invalid");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  openSession(session: LingServerPeerSessionV1): LingServerPeerSessionV1 {
    validateSession(session);
    return this.write(() => {
      const bound = { ...session, localRole: session.localRole ?? this.#role };
      this.assertSessionAuthority(bound);
      const current = this.getSession(session.sessionId);
      if (current) {
        if (!isDeepStrictEqual(bound, { ...current, localRole: current.localRole ?? this.#role })) {
          throw new DeviceFabricError("revision_conflict", "peer session cannot be rebound or rewind its sequences");
        }
        return current;
      }
      if (session.transportGeneration !== 1 || session.sendSequence !== 0 || session.receivedSequence !== 0) {
        throw new DeviceFabricError("revision_conflict", "new peer session must start at generation one with empty sequences");
      }
      this.assertRoute(bound, this.#now());
      this.saveSession(bound);
      return bound;
    });
  }

  switchRoute(sessionId: string, routeAttemptId: string, route: LingServerPeerSessionV1["route"], now = this.#now()): LingServerPeerSessionV1 {
    return this.write(() => {
      const current = this.requireSession(sessionId);
      const next: LingServerPeerSessionV1 = {
        ...current, routeAttemptId, route, localRole: this.#role,
        transportGeneration: current.transportGeneration + 1, sendSequence: 0, receivedSequence: 0, lastSeenAt: now,
      };
      validateSession(next);
      this.assertRoute(next, now);
      if (current.routeAttemptId === routeAttemptId && current.route === route) return current;
      this.saveSession(next);
      return next;
    });
  }

  acceptFrame(frame: LingServerPeerFrameV1): { readonly frame: LingServerPeerFrameV1; readonly replayed: boolean } {
    validateFrame(frame, this.#maxFrameBytes);
    return this.write(() => {
      const session = this.requireSession(frame.sessionId);
      if (frame.bindingId !== session.bindingId || frame.peerEpoch !== session.peerEpoch
        || frame.transportGeneration !== session.transportGeneration || frame.direction === this.outgoingDirection()) {
        throw new DeviceFabricError("safety_denied", "peer frame authority does not match the active session and lane");
      }
      const existing = this.getFrame(frame.frameId);
      if (existing) {
        if (!isDeepStrictEqual(existing, frame)) throw new DeviceFabricError("revision_conflict", "peer frame id is bound to another frame");
        return { frame: existing, replayed: true };
      }
      if (frame.sequence !== session.receivedSequence + 1) throw new DeviceFabricError("revision_conflict", "peer frame sequence is not contiguous");
      this.saveFrame(frame, { ...session, receivedSequence: frame.sequence, lastSeenAt: this.#now() });
      return { frame, replayed: false };
    });
  }

  sendFrame(sessionId: string, input: Omit<LingServerPeerFrameV1, "sessionId" | "bindingId" | "peerEpoch" | "transportGeneration" | "sequence">): { readonly frame: LingServerPeerFrameV1; readonly replayed: boolean } {
    return this.write(() => {
      const session = this.requireSession(sessionId);
      if (input.direction !== this.outgoingDirection()) throw new DeviceFabricError("safety_denied", "peer frame direction does not match the sender");
      const existing = this.getFrame(input.frameId);
      const frame: LingServerPeerFrameV1 = {
        ...input, sessionId, bindingId: session.bindingId, peerEpoch: session.peerEpoch,
        transportGeneration: session.transportGeneration, sequence: existing?.sequence ?? session.sendSequence + 1,
      };
      validateFrame(frame, this.#maxFrameBytes);
      if (existing) {
        if (!isDeepStrictEqual(existing, frame)) throw new DeviceFabricError("revision_conflict", "peer frame id is bound to another frame");
        return { frame: existing, replayed: true };
      }
      this.saveFrame(frame, { ...session, sendSequence: frame.sequence, lastSeenAt: this.#now() });
      return { frame, replayed: false };
    });
  }

  recordReceipt(receipt: LingServerCommandReceiptV1): LingServerCommandReceiptV1 {
    if (!receipt.commandId.trim() || !receipt.payloadDigest.trim()) throw new DeviceFabricError("revision_conflict", "peer command receipt is invalid");
    return this.write(() => {
      const current = this.#store ? this.#store.getReceipt(receipt.commandId) : this.#receipts.get(receipt.commandId);
      if (current) {
        if (current.payloadDigest !== receipt.payloadDigest) throw new DeviceFabricError("revision_conflict", "command id is bound to another payload");
        return current;
      }
      if (this.#store) this.#store.saveReceipt(receipt);
      else this.#receipts.set(receipt.commandId, receipt);
      return receipt;
    });
  }

  resume(sessionId: string, cursor: LingServerPeerResumeCursorV1): {
    readonly session: LingServerPeerSessionV1;
    readonly replayFromSequence: number;
    readonly frames: readonly LingServerPeerFrameV1[];
    readonly requiresSnapshot: boolean;
    readonly hasMore: boolean;
  } {
    if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !Number.isSafeInteger(cursor.transportGeneration)
      || cursor.transportGeneration < 1 || !["to_gateway", "to_mobile"].includes(cursor.direction)) {
      throw new DeviceFabricError("revision_conflict", "peer resume cursor is invalid");
    }
    return this.write(() => {
      const session = this.requireSession(sessionId);
      const highWater = cursor.direction === this.outgoingDirection() ? session.sendSequence : session.receivedSequence;
      const replayFromSequence = cursor.sequence + 1;
      const snapshot = { session, replayFromSequence, frames: [], requiresSnapshot: true, hasMore: false };
      if (cursor.transportGeneration !== session.transportGeneration || cursor.sequence > highWater) return snapshot;
      const frames = this.#store?.listFrames(sessionId, session.transportGeneration, cursor.direction, cursor.sequence) ?? [...this.#frames.values()]
        .filter(frame => frame.sessionId === sessionId && frame.transportGeneration === session.transportGeneration
          && frame.direction === cursor.direction && frame.sequence > cursor.sequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, 100);
      if ((cursor.sequence < highWater && frames.length === 0)
        || frames.some((frame, index) => frame.bindingId !== session.bindingId || frame.peerEpoch !== session.peerEpoch
          || frame.sequence !== replayFromSequence + index || frame.sequence > highWater)) return snapshot;
      const replayThrough = frames.at(-1)?.sequence ?? cursor.sequence;
      if (replayThrough < highWater && frames.length < 100) return snapshot;
      return { session, replayFromSequence, frames, requiresSnapshot: false, hasMore: replayThrough < highWater };
    });
  }

  private requireSession(sessionId: string): LingServerPeerSessionV1 {
    const session = this.getSession(sessionId);
    if (!session) throw new DeviceFabricError("target_missing", "peer session is missing");
    this.assertSessionAuthority(session);
    return session;
  }

  private assertSessionAuthority(session: LingServerPeerSessionV1): void {
    if (session.status !== "open" || (session.localRole ?? this.#role) !== this.#role) {
      throw new DeviceFabricError("safety_denied", "peer session is outside the local open role");
    }
    this.#registry.requireActiveBinding(session.bindingId, session.peerEpoch);
  }

  private assertRoute(session: LingServerPeerSessionV1, now: string): void {
    const route = this.#registry.requireRoute(session.routeAttemptId);
    if (route.bindingId !== session.bindingId || route.selected !== session.route || route.status !== "connected"
      || Date.parse(route.expiresAt) <= Date.parse(now)) {
      throw new DeviceFabricError("safety_denied", "peer session requires a connected route for the active binding");
    }
  }

  private outgoingDirection(): LingServerPeerFrameV1["direction"] {
    return this.#role === "gateway" ? "to_mobile" : "to_gateway";
  }

  private getSession(sessionId: string): LingServerPeerSessionV1 | undefined {
    return this.#store ? this.#store.getSession(sessionId) : this.#sessions.get(sessionId);
  }

  private getFrame(frameId: string): LingServerPeerFrameV1 | undefined {
    return this.#store ? this.#store.getFrame(frameId) : this.#frames.get(frameId);
  }

  private saveSession(session: LingServerPeerSessionV1): void {
    if (this.#store) this.#store.saveSession(session);
    else this.#sessions.set(session.sessionId, session);
  }

  private saveFrame(frame: LingServerPeerFrameV1, session: LingServerPeerSessionV1): void {
    if (this.#store) this.#store.saveFrame(frame);
    else this.#frames.set(frame.frameId, frame);
    this.saveSession(session);
  }

  private write<T>(work: () => T): T {
    return this.#store ? this.#store.withWriteTransaction(work) : work();
  }
}

function validateSession(session: LingServerPeerSessionV1): void {
  if (!session.sessionId.trim() || !session.bindingId.trim() || !session.routeAttemptId.trim()
    || [session.peerEpoch, session.transportGeneration].some(value => !Number.isSafeInteger(value) || value < 1)
    || [session.sendSequence, session.receivedSequence].some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isFinite(Date.parse(session.openedAt)) || !Number.isFinite(Date.parse(session.lastSeenAt))) {
    throw new DeviceFabricError("revision_conflict", "peer session identity is invalid");
  }
}

function validateFrame(frame: LingServerPeerFrameV1, maxBytes: number): void {
  if (!frame.frameId.trim() || !frame.sessionId.trim() || !frame.bindingId.trim()
    || [frame.peerEpoch, frame.transportGeneration, frame.sequence].some(value => !Number.isSafeInteger(value) || value < 1)
    || !["to_gateway", "to_mobile"].includes(frame.direction)
    || !["conversation", "device_task", "developer", "receipt", "control"].includes(frame.kind)
    || !Number.isFinite(Date.parse(frame.sentAt)) || Buffer.byteLength(JSON.stringify(frame), "utf8") > maxBytes) {
    throw new DeviceFabricError("invalid_graph", "peer frame is malformed or exceeds its size limit");
  }
}
