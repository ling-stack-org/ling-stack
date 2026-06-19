import { isSupportedSecretRef } from "./secrets.js";

export type LingSandboxBackendKind = "local_unix" | "docker" | "hosted" | "external";

export type LingSandboxCapability =
  | "process_isolation"
  | "filesystem_isolation"
  | "network_policy"
  | "artifact_export"
  | "secret_ref_injection"
  | "resource_limits"
  | "snapshot_restore";

export type LingSandboxReadinessStatus = "ready" | "blocked";

export type LingSandboxReadinessBlockerCode =
  | "sandbox_profile_missing"
  | "sandbox_backend_unverified"
  | "sandbox_artifact_import_unverified"
  | "sandbox_network_policy_unverified"
  | "sandbox_manifest_contains_raw_secret"
  | "sandbox_secret_ref_invalid"
  | "sandbox_profile_mismatch"
  | "sandbox_session_ref_invalid";

export interface LingSandboxReadinessBlocker {
  readonly code: LingSandboxReadinessBlockerCode;
  readonly message: string;
}

export type LingSandboxNetworkPolicy =
  | {
    readonly mode: "disabled";
  }
  | {
    readonly mode: "allowlist";
    readonly allowedHosts: readonly string[];
  };

export interface LingSandboxArtifactImportPolicy {
  readonly importRoot: string;
  readonly requireRedaction: boolean;
}

export interface LingSandboxProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly backendKind: LingSandboxBackendKind;
  readonly capabilities: readonly LingSandboxCapability[];
  readonly backendVerified: boolean;
  readonly artifactImportVerified: boolean;
  readonly networkPolicyVerified: boolean;
  readonly networkPolicy: LingSandboxNetworkPolicy;
  readonly artifactImport: LingSandboxArtifactImportPolicy;
}

export interface LingSandboxManifest {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly workspaceRoot: string;
  readonly artifactImportRoots: readonly string[];
  readonly networkPolicy?: LingSandboxNetworkPolicy;
  readonly env?: Readonly<Record<string, string>>;
  readonly secretEnvRefs?: Readonly<Record<string, string>>;
}

export interface LingSandboxSessionRef {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly backendKind: LingSandboxBackendKind;
  readonly opaqueSessionId: string;
  readonly resumeTokenRef?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface EvaluateLingSandboxReadinessInput {
  readonly profile?: LingSandboxProfile;
  readonly manifest?: LingSandboxManifest;
  readonly sessionRef?: LingSandboxSessionRef;
}

export interface LingSandboxReadinessReport {
  readonly status: LingSandboxReadinessStatus;
  readonly profileId?: string;
  readonly backendKind?: LingSandboxBackendKind;
  readonly blockingReasons: readonly LingSandboxReadinessBlocker[];
}

export const defaultLingSandboxNetworkPolicy = {
  mode: "disabled",
} as const satisfies LingSandboxNetworkPolicy;

export function evaluateLingSandboxReadiness(input: EvaluateLingSandboxReadinessInput): LingSandboxReadinessReport {
  const blockers: LingSandboxReadinessBlocker[] = [];
  const profile = input.profile;
  if (!profile) {
    blockers.push({
      code: "sandbox_profile_missing",
      message: "Sandbox-backed runner has no sandbox profile.",
    });
    return finishSandboxReadinessReport({ blockingReasons: blockers });
  }

  if (!profile.backendVerified) {
    blockers.push({
      code: "sandbox_backend_unverified",
      message: `Sandbox backend ${profile.displayName} has not been verified.`,
    });
  }
  if (!profile.artifactImportVerified) {
    blockers.push({
      code: "sandbox_artifact_import_unverified",
      message: `Sandbox profile ${profile.id} has not verified artifact import into Ling-owned roots.`,
    });
  }
  if (!profile.networkPolicyVerified || !isSafeNetworkPolicy(profile.networkPolicy)) {
    blockers.push({
      code: "sandbox_network_policy_unverified",
      message: `Sandbox profile ${profile.id} has not verified a disabled or allowlisted network policy.`,
    });
  }

  if (input.manifest) {
    blockers.push(...validateSandboxManifest(input.manifest, profile));
  }
  if (input.sessionRef) {
    blockers.push(...validateSandboxSessionRef(input.sessionRef, profile));
  }

  return finishSandboxReadinessReport({
    profileId: profile.id,
    backendKind: profile.backendKind,
    blockingReasons: blockers,
  });
}

export function normalizeLingSandboxNetworkPolicy(policy: LingSandboxNetworkPolicy | undefined): LingSandboxNetworkPolicy {
  return policy ?? defaultLingSandboxNetworkPolicy;
}

function validateSandboxManifest(manifest: LingSandboxManifest, profile: LingSandboxProfile): LingSandboxReadinessBlocker[] {
  const blockers: LingSandboxReadinessBlocker[] = [];
  if (manifest.profileId !== profile.id) {
    blockers.push({
      code: "sandbox_profile_mismatch",
      message: `Sandbox manifest profile ${manifest.profileId} does not match profile ${profile.id}.`,
    });
  }
  if (!isSafeNetworkPolicy(normalizeLingSandboxNetworkPolicy(manifest.networkPolicy))) {
    blockers.push({
      code: "sandbox_network_policy_unverified",
      message: "Sandbox manifest network policy must be disabled or use a non-empty allowlist.",
    });
  }
  if (!manifest.artifactImportRoots.length || !manifest.artifactImportRoots.every((root) => isInsideRoot(root, profile.artifactImport.importRoot))) {
    blockers.push({
      code: "sandbox_artifact_import_unverified",
      message: "Sandbox artifacts must import into the profile artifact import root.",
    });
  }
  for (const [name, value] of Object.entries(manifest.env ?? {})) {
    if (looksSecretLikeName(name) || looksSecretLikeValue(value)) {
      blockers.push({
        code: "sandbox_manifest_contains_raw_secret",
        message: `Sandbox manifest env.${name} looks secret-like; use secretEnvRefs instead.`,
      });
    }
  }
  for (const [name, ref] of Object.entries(manifest.secretEnvRefs ?? {})) {
    if (!isSupportedSecretRef(ref)) {
      blockers.push({
        code: "sandbox_secret_ref_invalid",
        message: `Sandbox manifest secretEnvRefs.${name} must use env:NAME or keychain:NAME.`,
      });
    }
  }
  return blockers;
}

function validateSandboxSessionRef(sessionRef: LingSandboxSessionRef, profile: LingSandboxProfile): LingSandboxReadinessBlocker[] {
  const blockers: LingSandboxReadinessBlocker[] = [];
  if (sessionRef.profileId !== profile.id || sessionRef.backendKind !== profile.backendKind || !sessionRef.opaqueSessionId.trim()) {
    blockers.push({
      code: "sandbox_session_ref_invalid",
      message: "Sandbox session ref must be opaque and match the verified sandbox profile.",
    });
  }
  if (sessionRef.resumeTokenRef && !isSupportedSecretRef(sessionRef.resumeTokenRef)) {
    blockers.push({
      code: "sandbox_session_ref_invalid",
      message: "Sandbox session resume token must be stored as a secret ref.",
    });
  }
  return blockers;
}

function isSafeNetworkPolicy(policy: LingSandboxNetworkPolicy): boolean {
  if (policy.mode === "disabled") {
    return true;
  }
  return policy.allowedHosts.length > 0 && policy.allowedHosts.every((host) => host.trim() === host && host.length > 0 && !host.includes("*"));
}

function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedRoot = stripTrailingSlash(root);
  const normalizedCandidate = stripTrailingSlash(candidate);
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function looksSecretLikeName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie");
}

function looksSecretLikeValue(value: string): boolean {
  const trimmed = value.trim();
  return /^bearer\s+\S+/i.test(trimmed) ||
    /^sk-[A-Za-z0-9_-]{8,}/.test(trimmed) ||
    /^github_pat_[A-Za-z0-9_]+/.test(trimmed) ||
    /^gh[opsu]_[A-Za-z0-9_]{8,}/.test(trimmed) ||
    /^xox[abprs]-[A-Za-z0-9-]+/.test(trimmed);
}

function finishSandboxReadinessReport(input: {
  readonly profileId?: string;
  readonly backendKind?: LingSandboxBackendKind;
  readonly blockingReasons: readonly LingSandboxReadinessBlocker[];
}): LingSandboxReadinessReport {
  const blockingReasons = dedupeSandboxBlockers(input.blockingReasons);
  return {
    status: blockingReasons.length === 0 ? "ready" : "blocked",
    profileId: input.profileId,
    backendKind: input.backendKind,
    blockingReasons,
  };
}

function dedupeSandboxBlockers(blockers: readonly LingSandboxReadinessBlocker[]): readonly LingSandboxReadinessBlocker[] {
  const seen = new Set<string>();
  const result: LingSandboxReadinessBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.code)) {
      continue;
    }
    seen.add(blocker.code);
    result.push(blocker);
  }
  return result;
}
