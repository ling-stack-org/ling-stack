import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  evaluateLingSandboxReadiness,
  type LingSandboxManifest,
  type LingSandboxNetworkPolicy,
  type LingSandboxProfile,
  type LingSandboxReadinessReport,
  type LingSandboxSessionRef,
} from "@ling-stack/core";
import type { PlatformNativeSandboxFeatureConfig } from "../../config.js";

const DEFAULT_PROFILE_ID = "platform-native-local";
const DEFAULT_MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface PlatformNativeSandboxBackendInput {
  readonly workspaceRoot: string;
  readonly config?: PlatformNativeSandboxFeatureConfig;
  readonly env?: Readonly<Record<string, string>>;
  readonly secretEnvRefs?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly now?: string;
}

export type PlatformNativeSandboxExecutableProbe = (file: string) => boolean | Promise<boolean>;

export interface PlatformNativeSandboxBackendCheck {
  readonly ok: boolean;
  readonly platform: NodeJS.Platform;
  readonly enforcement: PlatformNativeSandboxEnforcement;
  readonly profile: LingSandboxProfile;
  readonly manifest: LingSandboxManifest;
  readonly sessionRef: LingSandboxSessionRef;
  readonly readiness: LingSandboxReadinessReport;
  readonly diagnostics: readonly PlatformNativeSandboxDiagnostic[];
}

export type PlatformNativeSandboxEnforcement =
  | {
      readonly kind: "macos_sandbox_exec";
      readonly executable: string;
    }
  | {
      readonly kind: "unsupported";
    };

export interface PlatformNativeSandboxDiagnostic {
  readonly code:
    | "platform_native_disabled"
    | "platform_native_unsupported_platform"
    | "platform_native_enforcer_missing"
    | "platform_native_network_policy_unimplemented"
    | "platform_native_artifact_import_root_invalid";
  readonly message: string;
}

export interface PlatformNativeSandboxRunPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly sandboxProfile: string;
  readonly workspaceRoot: string;
  readonly artifactImportRoot: string;
  readonly networkMode: "disabled";
  readonly env: Readonly<Record<string, string>>;
  readonly secretEnvNames: readonly string[];
}

export async function checkPlatformNativeSandboxBackend(
  input: PlatformNativeSandboxBackendInput,
  executableProbe: PlatformNativeSandboxExecutableProbe = isExecutable,
): Promise<PlatformNativeSandboxBackendCheck> {
  const config = input.config ?? {};
  const platform = input.platform ?? process.platform;
  const diagnostics: PlatformNativeSandboxDiagnostic[] = [];
  const workspaceRoot = resolve(input.workspaceRoot);
  const artifactImportRoot = resolveArtifactImportRoot(workspaceRoot, config.artifactImportRoot);
  const artifactImportRootValid = isInsidePath(artifactImportRoot, join(workspaceRoot, ".ling", "artifacts"));
  if (!artifactImportRootValid) {
    diagnostics.push({
      code: "platform_native_artifact_import_root_invalid",
      message: "Platform-native sandbox artifact import root must live inside the Ling artifact root.",
    });
  }

  const networkPolicy: LingSandboxNetworkPolicy = config.networkPolicy ?? { mode: "disabled" };
  const networkPolicyVerified = networkPolicy.mode === "disabled";
  if (!networkPolicyVerified) {
    diagnostics.push({
      code: "platform_native_network_policy_unimplemented",
      message: "Platform-native sandbox verifies disabled networking only in P13.",
    });
  }

  let backendVerified = config.enabled === true;
  if (config.enabled !== true) {
    diagnostics.push({
      code: "platform_native_disabled",
      message: "Platform-native sandbox backend is disabled.",
    });
    backendVerified = false;
  }

  const enforcement = await resolveEnforcement(platform, config, executableProbe);
  if (enforcement.kind === "unsupported") {
    diagnostics.push({
      code: "platform_native_unsupported_platform",
      message: `Platform-native sandbox enforcement is not implemented for ${platform}.`,
    });
    backendVerified = false;
  } else if (!(await executableProbe(enforcement.executable))) {
    diagnostics.push({
      code: "platform_native_enforcer_missing",
      message: `Platform-native sandbox executable is unavailable: ${enforcement.executable}`,
    });
    backendVerified = false;
  }

  const profile = buildPlatformNativeSandboxProfile({
    backendVerified,
    artifactImportRoot,
    artifactImportVerified: artifactImportRootValid,
    networkPolicy,
    networkPolicyVerified,
  });
  const manifest = buildPlatformNativeSandboxManifest({
    profile,
    workspaceRoot,
    env: input.env,
    secretEnvRefs: input.secretEnvRefs,
  });
  const sessionRef = buildPlatformNativeSandboxSessionRef({
    profile,
    workspaceRoot,
    now: input.now ?? new Date().toISOString(),
  });
  const readiness = evaluateLingSandboxReadiness({ profile, manifest, sessionRef });
  return {
    ok: readiness.status === "ready",
    platform,
    enforcement,
    profile,
    manifest,
    sessionRef,
    readiness,
    diagnostics,
  };
}

export function buildPlatformNativeSandboxRunPlan(input: {
  readonly check: PlatformNativeSandboxBackendCheck;
  readonly command?: readonly string[];
}): PlatformNativeSandboxRunPlan {
  if (input.check.readiness.status !== "ready") {
    throw new Error(`Platform-native sandbox is not ready: ${input.check.readiness.blockingReasons.map((blocker) => blocker.code).join(", ")}`);
  }
  if (input.check.enforcement.kind !== "macos_sandbox_exec") {
    throw new Error(`Platform-native sandbox run plans are not implemented for ${input.check.platform}.`);
  }
  const sandboxProfile = buildMacosSandboxProfile({
    workspaceRoot: input.check.manifest.workspaceRoot,
    artifactImportRoot: input.check.profile.artifactImport.importRoot,
  });
  return {
    executable: input.check.enforcement.executable,
    args: [
      "-p",
      sandboxProfile,
      ...(input.command ?? []),
    ],
    sandboxProfile,
    workspaceRoot: input.check.manifest.workspaceRoot,
    artifactImportRoot: input.check.profile.artifactImport.importRoot,
    networkMode: "disabled",
    env: input.check.manifest.env ?? {},
    secretEnvNames: Object.keys(input.check.manifest.secretEnvRefs ?? {}),
  };
}

async function resolveEnforcement(
  platform: NodeJS.Platform,
  config: PlatformNativeSandboxFeatureConfig,
  _executableProbe: PlatformNativeSandboxExecutableProbe,
): Promise<PlatformNativeSandboxEnforcement> {
  if (platform === "darwin") {
    return {
      kind: "macos_sandbox_exec",
      executable: config.macosSandboxExecPath?.trim() || DEFAULT_MACOS_SANDBOX_EXEC,
    };
  }
  return { kind: "unsupported" };
}

function buildPlatformNativeSandboxProfile(input: {
  readonly backendVerified: boolean;
  readonly artifactImportRoot: string;
  readonly artifactImportVerified: boolean;
  readonly networkPolicy: LingSandboxNetworkPolicy;
  readonly networkPolicyVerified: boolean;
}): LingSandboxProfile {
  return {
    schemaVersion: 1,
    id: DEFAULT_PROFILE_ID,
    displayName: "Platform-native local sandbox",
    backendKind: "platform_native",
    capabilities: [
      "process_isolation",
      "filesystem_isolation",
      "network_policy",
      "artifact_export",
      "secret_ref_injection",
    ],
    backendVerified: input.backendVerified,
    artifactImportVerified: input.artifactImportVerified,
    networkPolicyVerified: input.networkPolicyVerified,
    networkPolicy: input.networkPolicy,
    artifactImport: {
      importRoot: input.artifactImportRoot,
      requireRedaction: true,
    },
  };
}

function buildPlatformNativeSandboxManifest(input: {
  readonly profile: LingSandboxProfile;
  readonly workspaceRoot: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly secretEnvRefs?: Readonly<Record<string, string>>;
}): LingSandboxManifest {
  return {
    schemaVersion: 1,
    profileId: input.profile.id,
    workspaceRoot: input.workspaceRoot,
    artifactImportRoots: [input.profile.artifactImport.importRoot],
    networkPolicy: input.profile.networkPolicy,
    ...(input.env ? { env: input.env } : {}),
    ...(input.secretEnvRefs ? { secretEnvRefs: input.secretEnvRefs } : {}),
  };
}

function buildPlatformNativeSandboxSessionRef(input: {
  readonly profile: LingSandboxProfile;
  readonly workspaceRoot: string;
  readonly now: string;
}): LingSandboxSessionRef {
  const digest = createHash("sha256").update(`${input.profile.id}:${input.workspaceRoot}`).digest("hex").slice(0, 16);
  return {
    schemaVersion: 1,
    profileId: input.profile.id,
    backendKind: input.profile.backendKind,
    opaqueSessionId: `platform-native-${digest}`,
    createdAt: input.now,
  };
}

function resolveArtifactImportRoot(workspaceRoot: string, configuredRoot: string | undefined): string {
  if (!configuredRoot?.trim()) {
    return join(workspaceRoot, ".ling", "artifacts", "sandbox", "platform-native");
  }
  return isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(workspaceRoot, configuredRoot);
}

function isInsidePath(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function buildMacosSandboxProfile(input: {
  readonly workspaceRoot: string;
  readonly artifactImportRoot: string;
}): string {
  const workspaceRoot = sandboxProfileString(input.workspaceRoot);
  const artifactImportRoot = sandboxProfileString(input.artifactImportRoot);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(deny network*)",
    `(allow file-read* (subpath ${workspaceRoot}))`,
    `(allow file-write* (subpath ${artifactImportRoot}))`,
    "(allow file-read* (subpath \"/bin\") (subpath \"/usr\") (subpath \"/System\") (subpath \"/Library\"))",
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-write* (subpath \"/tmp\") (subpath \"/private/tmp\"))",
  ].join("\n");
}

function sandboxProfileString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
