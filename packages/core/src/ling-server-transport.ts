import type {
  LingServerInstallationV1,
  LingServerPeerBindingV1,
  LingServerPeerRoleV1,
  LingServerPeerTransportConfigV1,
  LingServerRelayCredentialV1,
  LingServerRouteAttemptV1,
  LingServerTransportDiagnosticCheckV1,
  LingServerTransportDiagnosticsV1,
  LingServerTransportRouteV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";

export interface LingServerTransportPlannerOptions {
  readonly installation: LingServerInstallationV1;
  readonly protocolMajor?: number;
  readonly features?: readonly string[];
  readonly stunUrls?: readonly string[];
  readonly turnUrls?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly now?: () => string;
}

export interface LingServerTransportConfigInput {
  readonly binding: LingServerPeerBindingV1;
  readonly route: LingServerRouteAttemptV1;
  readonly role: LingServerPeerRoleV1;
  readonly localKeyFingerprint: string;
  readonly remoteKeyFingerprint: string;
  readonly expiresAt: string;
  readonly relayCredential?: LingServerRelayCredentialV1;
}

export interface LingServerTransportDiagnosticInput {
  readonly binding: LingServerPeerBindingV1;
  readonly route: LingServerRouteAttemptV1;
  readonly diagnosticId: string;
  readonly checks: readonly LingServerTransportDiagnosticCheckV1[];
  readonly transportGeneration?: number;
  readonly localCandidateCount?: number;
  readonly remoteCandidateCount?: number;
  readonly requestedResumeSequence?: number;
  readonly replayedFrameCount?: number;
  readonly requiresSnapshot?: boolean;
  readonly generatedAt?: string;
}

/** Builds ephemeral transport input and redacted diagnostics without implementing WebRTC. */
export class LingServerTransportPlanner {
  readonly #installation: LingServerInstallationV1;
  readonly #protocolMajor: number;
  readonly #features: readonly string[];
  readonly #stunUrls: readonly string[];
  readonly #turnUrls: readonly string[];
  readonly #maxFrameBytes: number;
  readonly #now: () => string;

  constructor(options: LingServerTransportPlannerOptions) {
    if (!/^https:\/\//u.test(options.installation.serverOrigin)) throw new DeviceFabricError("invalid_graph", "Ling Server origin must use HTTPS");
    if (!options.installation.applicationKeyFingerprint.trim()) throw new DeviceFabricError("revision_conflict", "Ling Server application fingerprint is required");
    this.#installation = options.installation;
    this.#protocolMajor = options.protocolMajor ?? 1;
    this.#features = [...new Set(options.features ?? [])];
    this.#stunUrls = normalizeServerUrls(options.stunUrls ?? [], "stun");
    this.#turnUrls = normalizeServerUrls(options.turnUrls ?? [], "turn");
    this.#maxFrameBytes = options.maxFrameBytes ?? 256 * 1024;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (!Number.isInteger(this.#protocolMajor) || this.#protocolMajor < 1) throw new DeviceFabricError("revision_conflict", "transport protocol major is invalid");
    if (!Number.isInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1024 || this.#maxFrameBytes > 4 * 1024 * 1024) throw new DeviceFabricError("revision_conflict", "transport frame limit is invalid");
  }

  createConfig(input: LingServerTransportConfigInput): LingServerPeerTransportConfigV1 {
    validateBinding(input.binding);
    validateRoute(input.route, input.binding);
    if (!input.localKeyFingerprint.trim() || !input.remoteKeyFingerprint.trim()) throw new DeviceFabricError("safety_denied", "peer key fingerprints are required");
    assertFuture(input.expiresAt, this.#now(), "transport configuration");
    if (input.route.selected !== "relay" && input.relayCredential) throw new DeviceFabricError("safety_denied", "relay credentials require a relay route");
    if (input.route.selected === "relay") {
      if (this.#turnUrls.length === 0 || !input.relayCredential) throw new DeviceFabricError("target_missing", "relay route requires TURN configuration and credentials");
      assertFuture(input.relayCredential.expiresAt, this.#now(), "relay credential");
      if (Date.parse(input.relayCredential.expiresAt) < Date.parse(input.expiresAt)) throw new DeviceFabricError("safety_denied", "relay credential expires before transport configuration");
      if (!/^turns?:/u.test(input.relayCredential.url)) throw new DeviceFabricError("revision_conflict", "relay credential URL must use TURN");
    }
    if (input.route.selected !== "relay" && this.#stunUrls.length === 0) throw new DeviceFabricError("target_missing", "direct route requires STUN configuration");
    return {
      schemaVersion: 1,
      bindingId: input.binding.bindingId,
      routeAttemptId: input.route.routeAttemptId,
      role: input.role,
      route: input.route.selected!,
      peerEpoch: input.binding.epoch,
      serverOrigin: this.#installation.serverOrigin,
      applicationKeyFingerprint: this.#installation.applicationKeyFingerprint,
      localKeyFingerprint: input.localKeyFingerprint,
      remoteKeyFingerprint: input.remoteKeyFingerprint,
      protocolMajor: this.#protocolMajor,
      features: this.#features,
      stunUrls: this.#stunUrls,
      turnUrls: this.#turnUrls,
      ...(input.relayCredential ? { relayCredential: input.relayCredential } : {}),
      expiresAt: input.expiresAt,
      maxFrameBytes: this.#maxFrameBytes,
    };
  }

  createDiagnostics(input: LingServerTransportDiagnosticInput): LingServerTransportDiagnosticsV1 {
    validateBinding(input.binding);
    validateRoute(input.route, input.binding);
    if (!input.diagnosticId.trim()) throw new DeviceFabricError("revision_conflict", "transport diagnostic id is required");
    const checks = input.checks.map(check => {
      if (!check.id || !check.code.trim()) throw new DeviceFabricError("revision_conflict", "transport diagnostic check is incomplete");
      if (check.latencyMs !== undefined && (!Number.isFinite(check.latencyMs) || check.latencyMs < 0)) throw new DeviceFabricError("revision_conflict", "transport diagnostic latency is invalid");
      return { ...check };
    });
    return {
      diagnosticId: input.diagnosticId,
      bindingId: input.binding.bindingId,
      routeAttemptId: input.route.routeAttemptId,
      peerEpoch: input.binding.epoch,
      ...(input.route.selected ? { selectedRoute: input.route.selected } : {}),
      ...(input.transportGeneration !== undefined ? { transportGeneration: input.transportGeneration } : {}),
      checks,
      ...(input.localCandidateCount !== undefined ? { localCandidateCount: nonNegativeInteger(input.localCandidateCount, "local candidate count") } : {}),
      ...(input.remoteCandidateCount !== undefined ? { remoteCandidateCount: nonNegativeInteger(input.remoteCandidateCount, "remote candidate count") } : {}),
      ...(input.requestedResumeSequence !== undefined ? { requestedResumeSequence: nonNegativeInteger(input.requestedResumeSequence, "resume sequence") } : {}),
      ...(input.replayedFrameCount !== undefined ? { replayedFrameCount: nonNegativeInteger(input.replayedFrameCount, "replayed frame count") } : {}),
      ...(input.requiresSnapshot !== undefined ? { requiresSnapshot: input.requiresSnapshot } : {}),
      generatedAt: input.generatedAt ?? this.#now(),
    };
  }
}

function validateBinding(binding: LingServerPeerBindingV1): void {
  if (!binding.bindingId.trim() || !binding.installationId.trim() || !binding.gatewayId.trim() || !binding.mobileDeviceId.trim() || binding.epoch < 1 || binding.status !== "active") {
    throw new DeviceFabricError("safety_denied", "transport requires an active peer binding");
  }
}

function validateRoute(route: LingServerRouteAttemptV1, binding: LingServerPeerBindingV1): void {
  if (!route.routeAttemptId.trim() || route.bindingId !== binding.bindingId || route.status !== "connected" || !route.selected) throw new DeviceFabricError("safety_denied", "transport requires a selected connected route");
}

function normalizeServerUrls(urls: readonly string[], scheme: "stun" | "turn"): readonly string[] {
  const normalized = [...new Set(urls.map(url => url.trim()).filter(Boolean))];
  for (const url of normalized) if (!new RegExp(`^${scheme}s?:`, "u").test(url)) throw new DeviceFabricError("revision_conflict", `${scheme.toUpperCase()} URL has an invalid scheme`);
  return normalized;
}

function assertFuture(value: string, now: string, label: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.parse(now)) throw new DeviceFabricError("safety_denied", `${label} has expired`);
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new DeviceFabricError("revision_conflict", `${label} is invalid`);
  return value;
}
