import { createHmac } from "node:crypto";
import {
  LING_SERVER_PEER_FRAME_DEFAULT_BYTES_V1,
  LING_SERVER_PEER_FRAME_MAX_BYTES_V1,
  type LingServerInstallationV1,
  type LingServerPeerBindingV1,
  type LingServerPeerRoleV1,
  type LingServerPeerTransportConfigV1,
  type LingServerRelayCredentialV1,
  type LingServerRouteAttemptV1,
  type LingServerTransportDiagnosticCheckV1,
  type LingServerTransportDiagnosticsV1,
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

export interface LingServerRelayCredentialIssuerOptions {
  readonly turnUrls: readonly string[];
  readonly sharedSecret: string | Uint8Array;
  readonly now?: () => string;
  readonly maxTtlMs?: number;
  readonly maxActiveCredentialsPerBinding?: number;
}

/** Issues short-lived, binding-scoped coturn REST credentials without persisting secrets. */
export class LingServerRelayCredentialIssuer {
  readonly #turnUrls: readonly string[];
  readonly #sharedSecret: Uint8Array;
  readonly #now: () => string;
  readonly #maxTtlMs: number;
  readonly #maxActiveCredentialsPerBinding: number;
  readonly #issued = new Map<string, string>();

  constructor(options: LingServerRelayCredentialIssuerOptions) {
    this.#turnUrls = normalizeServerUrls(options.turnUrls, "turn");
    this.#sharedSecret = typeof options.sharedSecret === "string" ? Buffer.from(options.sharedSecret, "utf8") : Buffer.from(options.sharedSecret);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxTtlMs = options.maxTtlMs ?? 60 * 60_000;
    this.#maxActiveCredentialsPerBinding = options.maxActiveCredentialsPerBinding ?? 16;
    if (this.#turnUrls.length === 0 || this.#sharedSecret.byteLength < 16 || !Number.isInteger(this.#maxTtlMs) || this.#maxTtlMs < 30_000
      || !Number.isInteger(this.#maxActiveCredentialsPerBinding) || this.#maxActiveCredentialsPerBinding < 1) {
      throw new DeviceFabricError("revision_conflict", "relay credential issuer configuration is invalid");
    }
  }

  issue(input: { readonly binding: LingServerPeerBindingV1; readonly role: LingServerPeerRoleV1; readonly ttlMs?: number }): LingServerRelayCredentialV1 {
    if (input.binding.status !== "active" || !input.binding.bindingId.trim() || !Number.isSafeInteger(input.binding.epoch) || input.binding.epoch < 1) {
      throw new DeviceFabricError("safety_denied", "relay credential requires an active peer binding");
    }
    const now = this.#now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new DeviceFabricError("revision_conflict", "relay credential issuer clock is invalid");
    for (const [key, expiresAt] of this.#issued) if (Date.parse(expiresAt) <= nowMs) this.#issued.delete(key);
    const activeCount = [...this.#issued.keys()].filter(key => key.startsWith(`${input.binding.bindingId}:`)).length;
    if (activeCount >= this.#maxActiveCredentialsPerBinding) throw new DeviceFabricError("lease_busy", "relay credential quota is exhausted for this binding");
    const ttlMs = input.ttlMs ?? this.#maxTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > this.#maxTtlMs) throw new DeviceFabricError("revision_conflict", "relay credential TTL is outside the configured range");
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const username = `${Math.floor((nowMs + ttlMs) / 1000)}:${input.binding.bindingId}:${input.binding.epoch}:${input.role}`;
    const credential = createHmac("sha1", this.#sharedSecret).update(username, "utf8").digest("base64");
    this.#issued.set(`${input.binding.bindingId}:${username}`, expiresAt);
    return { url: this.#turnUrls[0]!, username, credential, expiresAt };
  }
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
    this.#maxFrameBytes = options.maxFrameBytes ?? LING_SERVER_PEER_FRAME_DEFAULT_BYTES_V1;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (!Number.isInteger(this.#protocolMajor) || this.#protocolMajor < 1) throw new DeviceFabricError("revision_conflict", "transport protocol major is invalid");
    if (!Number.isInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1024 || this.#maxFrameBytes > LING_SERVER_PEER_FRAME_MAX_BYTES_V1) {
      throw new DeviceFabricError("revision_conflict", "transport frame limit is invalid");
    }
  }

  createConfig(input: LingServerTransportConfigInput): LingServerPeerTransportConfigV1 {
    validateBinding(input.binding, this.#installation);
    validateRoute(input.route, input.binding);
    const gateway = input.role === "gateway";
    if ((!gateway && input.role !== "mobile")
      || input.localKeyFingerprint !== (gateway ? input.binding.gatewayKeyFingerprint : input.binding.mobileKeyFingerprint)
      || input.remoteKeyFingerprint !== (gateway ? input.binding.mobileKeyFingerprint : input.binding.gatewayKeyFingerprint)) {
      throw new DeviceFabricError("safety_denied", "transport peer keys do not match the requested role");
    }
    const now = this.#now();
    assertFuture(input.expiresAt, now, "transport configuration");
    assertFuture(input.route.expiresAt, now, "route attempt");
    if (Date.parse(input.expiresAt) > Date.parse(input.route.expiresAt)) {
      throw new DeviceFabricError("safety_denied", "transport configuration would outlive the route attempt");
    }
    if (input.route.selected !== "relay" && input.relayCredential) throw new DeviceFabricError("safety_denied", "relay credentials require a relay route");
    if (input.route.selected === "relay") {
      if (this.#turnUrls.length === 0 || !input.relayCredential) throw new DeviceFabricError("target_missing", "relay route requires TURN configuration and credentials");
      assertFuture(input.relayCredential.expiresAt, now, "relay credential");
      if (Date.parse(input.relayCredential.expiresAt) < Date.parse(input.expiresAt)) throw new DeviceFabricError("safety_denied", "relay credential expires before transport configuration");
      if (!this.#turnUrls.includes(input.relayCredential.url)) throw new DeviceFabricError("safety_denied", "relay credential URL is outside the configured TURN endpoints");
    }
    if (input.route.selected === "direct" && this.#stunUrls.length === 0) throw new DeviceFabricError("target_missing", "direct route requires STUN configuration");
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
    validateBinding(input.binding, this.#installation);
    validateRoute(input.route, input.binding);
    if (!input.diagnosticId.trim()) throw new DeviceFabricError("revision_conflict", "transport diagnostic id is required");
    const checks = input.checks.map(check => {
      if (!diagnosticIds.has(check.id) || !["pass", "fail", "unknown"].includes(check.status)
        || !/^[a-z0-9_:-]{1,64}$/u.test(check.code)) throw new DeviceFabricError("revision_conflict", "transport diagnostic check is invalid");
      if (check.latencyMs !== undefined && (!Number.isFinite(check.latencyMs) || check.latencyMs < 0)) throw new DeviceFabricError("revision_conflict", "transport diagnostic latency is invalid");
      return { id: check.id, status: check.status, code: check.code, ...(check.latencyMs === undefined ? {} : { latencyMs: check.latencyMs }) };
    });
    if (checks.length !== new Set(checks.map(check => check.id)).size) throw new DeviceFabricError("revision_conflict", "transport diagnostic check is repeated");
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

const diagnosticIds = new Set(["control_reachability", "peer_presence", "signaling", "candidate_gathering",
  "peer_handshake", "cursor_resume", "relay_quota", "revocation"]);

function validateBinding(binding: LingServerPeerBindingV1, installation: LingServerInstallationV1): void {
  if (binding.installationId !== installation.installationId || installation.status !== "active"
    || !binding.bindingId.trim() || !binding.gatewayId.trim() || !binding.mobileDeviceId.trim()
    || !binding.gatewayKeyFingerprint.trim() || !binding.mobileKeyFingerprint.trim()
    || !Number.isSafeInteger(binding.epoch) || binding.epoch < 1 || binding.status !== "active") {
    throw new DeviceFabricError("safety_denied", "transport requires an active peer binding");
  }
}

function validateRoute(route: LingServerRouteAttemptV1, binding: LingServerPeerBindingV1): void {
  if (!route.routeAttemptId.trim() || route.bindingId !== binding.bindingId || (route.peerEpoch ?? 1) !== binding.epoch
    || route.status !== "connected" || !route.selected) throw new DeviceFabricError("safety_denied", "transport requires a connected route for the bound epoch");
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
