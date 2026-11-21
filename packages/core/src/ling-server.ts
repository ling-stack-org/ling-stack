import type { LingServerCommandReceiptV1, LingServerInstallationV1, LingServerPeerBindingV1, LingServerPeerFrameV1, LingServerPeerSessionV1, LingServerRouteAttemptV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";
import type { SqliteLingServerStore } from "./storage/sqlite/ling-server-store.js";

export interface LingServerPeerRegistryOptions {
  readonly store?: SqliteLingServerStore;
}

export class LingServerPeerRegistry {
  readonly #installations = new Map<string, LingServerInstallationV1>();
  readonly #bindings = new Map<string, LingServerPeerBindingV1>();
  readonly #routes = new Map<string, LingServerRouteAttemptV1>();

  readonly #store?: SqliteLingServerStore;

  constructor(options: LingServerPeerRegistryOptions = {}) {
    this.#store = options.store;
  }

  registerInstallation(installation: LingServerInstallationV1): LingServerInstallationV1 {
    const current = this.#installations.get(installation.installationId) ?? this.#store?.getInstallation(installation.installationId);
    if (current && installation.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "Ling Server installation revision must advance");
    if (!/^https:\/\//u.test(installation.serverOrigin)) throw new DeviceFabricError("invalid_graph", "Ling Server origin must use HTTPS");
    this.#installations.set(installation.installationId, installation);
    this.#store?.saveInstallation(installation);
    return installation;
  }

  bindPeers(binding: LingServerPeerBindingV1): LingServerPeerBindingV1 {
    const installation = this.#installations.get(binding.installationId) ?? this.#store?.getInstallation(binding.installationId);
    if (!installation || installation.status !== "active") throw new DeviceFabricError("target_missing", "Ling Server installation is unavailable");
    const current = this.#bindings.get(binding.bindingId) ?? this.#store?.getBinding(binding.bindingId);
    if (current && binding.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "peer binding revision must advance");
    const knownBindings = [...this.#bindings.values(), ...(this.#store?.listBindings() ?? [])];
    if (binding.status === "active" && knownBindings.some(item => item.bindingId !== binding.bindingId && item.gatewayId === binding.gatewayId && item.status === "active")) throw new DeviceFabricError("revision_conflict", "gateway already has an active peer binding");
    this.#bindings.set(binding.bindingId, binding);
    this.#store?.saveBinding(binding);
    return binding;
  }

  revokeBinding(bindingId: string, revision: number): LingServerPeerBindingV1 {
    const binding = this.#bindings.get(bindingId) ?? this.#store?.getBinding(bindingId);
    if (!binding) throw new DeviceFabricError("target_missing", "peer binding is missing");
    const revoked = { ...binding, status: "revoked" as const, epoch: binding.epoch + 1, revision };
    this.#bindings.set(bindingId, revoked);
    this.#store?.saveBinding(revoked);
    return revoked;
  }

  beginRoute(route: LingServerRouteAttemptV1): LingServerRouteAttemptV1 {
    const binding = this.#bindings.get(route.bindingId) ?? this.#store?.getBinding(route.bindingId);
    if (!binding || binding.status !== "active") throw new DeviceFabricError("safety_denied", "route requires an active peer binding");
    this.#routes.set(route.routeAttemptId, route);
    this.#store?.saveRoute(route);
    return route;
  }

  selectRoute(routeAttemptId: string, selected: "lan" | "direct" | "relay", now: string): LingServerRouteAttemptV1 {
    const route = this.#routes.get(routeAttemptId) ?? this.#store?.getRoute(routeAttemptId);
    if (!route) throw new DeviceFabricError("target_missing", "route attempt is missing");
    if (Date.parse(route.expiresAt) <= Date.parse(now)) throw new DeviceFabricError("safety_denied", "route attempt has expired");
    const next = { ...route, selected, status: "connected" as const };
    this.#routes.set(routeAttemptId, next);
    this.#store?.saveRoute(next);
    return next;
  }

  failoverRoute(routeAttemptId: string, now: string): LingServerRouteAttemptV1 {
    const route = this.#routes.get(routeAttemptId) ?? this.#store?.getRoute(routeAttemptId);
    if (!route) throw new DeviceFabricError("target_missing", "route attempt is missing");
    const next = Date.parse(route.expiresAt) <= Date.parse(now)
      ? { ...route, status: "expired" as const }
      : route.selected === "lan" || route.selected === "direct" || !route.selected
        ? { ...route, preferred: "relay" as const, status: "checking" as const }
        : { ...route, status: "failed" as const };
    this.#routes.set(routeAttemptId, next);
    this.#store?.saveRoute(next);
    return next;
  }
}

export class LingServerPeerSessionCoordinator {
  readonly #store?: SqliteLingServerStore;
  readonly #sessions = new Map<string, LingServerPeerSessionV1>();
  readonly #now: () => string;

  constructor(options: { readonly store?: SqliteLingServerStore; readonly now?: () => string } = {}) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  openSession(session: LingServerPeerSessionV1): LingServerPeerSessionV1 {
    validateSession(session);
    const current = this.#sessions.get(session.sessionId) ?? this.#store?.getSession(session.sessionId);
    if (current && session.transportGeneration < current.transportGeneration) throw new DeviceFabricError("revision_conflict", "peer session transport generation regressed");
    const binding = this.#store?.getBinding(session.bindingId);
    if (binding && (binding.status !== "active" || binding.epoch !== session.peerEpoch)) throw new DeviceFabricError("safety_denied", "peer session binding is not active for this epoch");
    this.#sessions.set(session.sessionId, session);
    this.#store?.saveSession(session);
    return session;
  }

  switchRoute(sessionId: string, routeAttemptId: string, route: LingServerPeerSessionV1["route"], now = this.#now()): LingServerPeerSessionV1 {
    const current = this.requireSession(sessionId);
    const next: LingServerPeerSessionV1 = { ...current, routeAttemptId, route, transportGeneration: current.transportGeneration + 1, sendSequence: 0, receivedSequence: 0, status: "open", lastSeenAt: now };
    this.#sessions.set(sessionId, next);
    this.#store?.saveSession(next);
    return next;
  }

  acceptFrame(frame: LingServerPeerFrameV1): { readonly frame: LingServerPeerFrameV1; readonly replayed: boolean } {
    const session = this.requireSession(frame.sessionId);
    const existing = this.#store?.getFrame(frame.frameId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(frame)) throw new DeviceFabricError("revision_conflict", "peer frame id is bound to another frame");
      return { frame: existing, replayed: true };
    }
    if (session.status !== "open" || frame.bindingId !== session.bindingId || frame.peerEpoch !== session.peerEpoch || frame.transportGeneration !== session.transportGeneration) {
      throw new DeviceFabricError("safety_denied", "peer frame authority does not match the active session");
    }
    if (frame.sequence !== session.receivedSequence + 1) throw new DeviceFabricError("revision_conflict", "peer frame sequence is not contiguous");
    const next = { ...session, receivedSequence: frame.sequence, lastSeenAt: frame.sentAt };
    this.#store?.saveFrame(frame);
    this.#store?.saveSession(next);
    this.#sessions.set(session.sessionId, next);
    return { frame, replayed: false };
  }

  sendFrame(sessionId: string, input: Omit<LingServerPeerFrameV1, "sessionId" | "bindingId" | "peerEpoch" | "transportGeneration" | "sequence">): { readonly frame: LingServerPeerFrameV1; readonly replayed: boolean } {
    const session = this.requireSession(sessionId);
    const existing = this.#store?.getFrame(input.frameId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify({ ...input, sessionId: session.sessionId, bindingId: session.bindingId, peerEpoch: session.peerEpoch, transportGeneration: session.transportGeneration, sequence: existing.sequence })) throw new DeviceFabricError("revision_conflict", "peer frame id is bound to another frame");
      return { frame: existing, replayed: true };
    }
    if (session.status !== "open") throw new DeviceFabricError("safety_denied", "peer session is not open");
    const frame: LingServerPeerFrameV1 = { ...input, sessionId: session.sessionId, bindingId: session.bindingId, peerEpoch: session.peerEpoch, transportGeneration: session.transportGeneration, sequence: session.sendSequence + 1 };
    const next = { ...session, sendSequence: frame.sequence, lastSeenAt: frame.sentAt };
    this.#store?.saveFrame(frame);
    this.#store?.saveSession(next);
    this.#sessions.set(session.sessionId, next);
    return { frame, replayed: false };
  }

  recordReceipt(receipt: LingServerCommandReceiptV1): LingServerCommandReceiptV1 {
    if (!receipt.commandId.trim() || !receipt.payloadDigest.trim()) throw new DeviceFabricError("revision_conflict", "peer command receipt is invalid");
    const current = this.#store?.getReceipt(receipt.commandId);
    if (current) {
      if (current.payloadDigest !== receipt.payloadDigest) throw new DeviceFabricError("revision_conflict", "command id is bound to another payload");
      return current;
    }
    this.#store?.saveReceipt(receipt);
    return receipt;
  }

  resume(sessionId: string, lastReceivedSequence: number): { readonly session: LingServerPeerSessionV1; readonly replayFromSequence: number; readonly frames: readonly LingServerPeerFrameV1[]; readonly requiresSnapshot: boolean } {
    if (!Number.isInteger(lastReceivedSequence) || lastReceivedSequence < 0) throw new DeviceFabricError("revision_conflict", "peer resume cursor is invalid");
    const session = this.requireSession(sessionId);
    const frames = this.#store?.listFrames(sessionId, session.transportGeneration, lastReceivedSequence) ?? [];
    return { session, replayFromSequence: lastReceivedSequence + 1, frames, requiresSnapshot: lastReceivedSequence > session.receivedSequence || (lastReceivedSequence < session.receivedSequence && frames.length === 0) };
  }

  private requireSession(sessionId: string): LingServerPeerSessionV1 {
    const session = this.#sessions.get(sessionId) ?? this.#store?.getSession(sessionId);
    if (!session) throw new DeviceFabricError("target_missing", "peer session is missing");
    this.#sessions.set(sessionId, session);
    return session;
  }
}

function validateSession(session: LingServerPeerSessionV1): void {
  if (!session.sessionId.trim() || !session.bindingId.trim() || !session.routeAttemptId.trim() || session.peerEpoch < 1 || session.transportGeneration < 1 || session.sendSequence < 0 || session.receivedSequence < 0 || !session.openedAt.trim() || !session.lastSeenAt.trim()) {
    throw new DeviceFabricError("revision_conflict", "peer session identity is invalid");
  }
}
