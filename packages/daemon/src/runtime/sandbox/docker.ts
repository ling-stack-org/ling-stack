import { execFile } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  evaluateLingSandboxReadiness,
  type LingSandboxManifest,
  type LingSandboxNetworkPolicy,
  type LingSandboxProfile,
  type LingSandboxReadinessReport,
} from "@ling-stack/core";
import type { DockerSandboxFeatureConfig } from "../../config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_DOCKER_BINARY = "docker";
const DEFAULT_PROFILE_ID = "docker-default";
const DEFAULT_SANDBOX_WORKSPACE = "/workspace";
const DEFAULT_SANDBOX_ARTIFACTS = "/ling-artifacts";

export interface DockerSandboxBackendInput {
  readonly workspaceRoot: string;
  readonly config?: DockerSandboxFeatureConfig;
  readonly env?: Readonly<Record<string, string>>;
  readonly secretEnvRefs?: Readonly<Record<string, string>>;
}

export interface DockerSandboxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type DockerSandboxCommandRunner = (
  file: string,
  args: readonly string[],
) => DockerSandboxCommandResult | Promise<DockerSandboxCommandResult>;

export interface DockerSandboxBackendCheck {
  readonly ok: boolean;
  readonly dockerBinary: string;
  readonly image?: string;
  readonly resourceLimits?: DockerSandboxResourceLimits;
  readonly profile: LingSandboxProfile;
  readonly manifest: LingSandboxManifest;
  readonly readiness: LingSandboxReadinessReport;
  readonly diagnostics: readonly DockerSandboxDiagnostic[];
}

export interface DockerSandboxResourceLimits {
  readonly cpus?: number;
  readonly memoryMb?: number;
}

export interface DockerSandboxDiagnostic {
  readonly code:
    | "docker_disabled"
    | "docker_image_missing"
    | "docker_daemon_unreachable"
    | "docker_image_unavailable"
    | "docker_network_policy_unimplemented"
    | "docker_artifact_import_root_invalid";
  readonly message: string;
}

export interface DockerSandboxRunPlan {
  readonly dockerBinary: string;
  readonly args: readonly string[];
  readonly workspaceMount: {
    readonly hostPath: string;
    readonly containerPath: string;
    readonly mode: "read_only" | "read_write";
  };
  readonly artifactMount: {
    readonly hostPath: string;
    readonly containerPath: string;
  };
  readonly networkMode: "none";
  readonly env: Readonly<Record<string, string>>;
  readonly secretEnvNames: readonly string[];
}

export async function checkDockerSandboxBackend(
  input: DockerSandboxBackendInput,
  commandRunner: DockerSandboxCommandRunner = runDockerCommand,
): Promise<DockerSandboxBackendCheck> {
  const config = input.config ?? {};
  const dockerBinary = config.dockerBinary?.trim() || DEFAULT_DOCKER_BINARY;
  const image = config.image?.trim();
  const diagnostics: DockerSandboxDiagnostic[] = [];
  const workspaceRoot = resolve(input.workspaceRoot);
  const artifactImportRoot = resolveArtifactImportRoot(workspaceRoot, config.artifactImportRoot);
  const artifactImportRootValid = isInsidePath(artifactImportRoot, join(workspaceRoot, ".ling", "artifacts"));
  if (!artifactImportRootValid) {
    diagnostics.push({
      code: "docker_artifact_import_root_invalid",
      message: "Docker sandbox artifact import root must live inside the Ling artifact root.",
    });
  }
  const networkPolicy: LingSandboxNetworkPolicy = config.networkPolicy ?? { mode: "disabled" };
  const networkPolicyVerified = networkPolicy.mode === "disabled";
  if (!networkPolicyVerified) {
    diagnostics.push({
      code: "docker_network_policy_unimplemented",
      message: "Docker sandbox P12 verifies disabled networking only.",
    });
  }

  let backendVerified = config.enabled === true && Boolean(image);
  if (config.enabled !== true) {
    diagnostics.push({ code: "docker_disabled", message: "Docker sandbox backend is disabled." });
    backendVerified = false;
  }
  if (!image) {
    diagnostics.push({ code: "docker_image_missing", message: "Docker sandbox image is not configured." });
    backendVerified = false;
  }
  if (backendVerified) {
    const daemon = await safeDockerCommand(commandRunner, dockerBinary, ["info", "--format", "{{json .ServerVersion}}"]);
    if (!daemon.ok) {
      diagnostics.push({ code: "docker_daemon_unreachable", message: "Docker daemon readiness probe failed." });
      backendVerified = false;
    }
  }
  if (backendVerified && image) {
    const inspect = await safeDockerCommand(commandRunner, dockerBinary, ["image", "inspect", image, "--format", "{{.Id}}"]);
    if (!inspect.ok) {
      diagnostics.push({ code: "docker_image_unavailable", message: `Docker sandbox image is unavailable: ${image}` });
      backendVerified = false;
    }
  }

  const profile = buildDockerSandboxProfile({
    backendVerified,
    artifactImportRoot,
    artifactImportVerified: artifactImportRootValid,
    networkPolicy,
    networkPolicyVerified,
  });
  const manifest = buildDockerSandboxManifest({
    profile,
    workspaceRoot,
    env: input.env,
    secretEnvRefs: input.secretEnvRefs,
  });
  const readiness = evaluateLingSandboxReadiness({ profile, manifest });
  return {
    ok: readiness.status === "ready",
    dockerBinary,
    ...(image ? { image } : {}),
    ...readResourceLimits(config),
    profile,
    manifest,
    readiness,
    diagnostics,
  };
}

export function buildDockerSandboxRunPlan(input: {
  readonly check: DockerSandboxBackendCheck;
  readonly command?: readonly string[];
}): DockerSandboxRunPlan {
  if (!input.check.image) {
    throw new Error("Docker sandbox image is required before building a run plan.");
  }
  if (input.check.readiness.status !== "ready") {
    throw new Error(`Docker sandbox is not ready: ${input.check.readiness.blockingReasons.map((blocker) => blocker.code).join(", ")}`);
  }
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    mountArg(input.check.manifest.workspaceRoot, DEFAULT_SANDBOX_WORKSPACE, "read_only"),
    "--mount",
    mountArg(input.check.profile.artifactImport.importRoot, DEFAULT_SANDBOX_ARTIFACTS, "read_write"),
    "-w",
    DEFAULT_SANDBOX_WORKSPACE,
    ...dockerResourceArgs(input.check),
    ...dockerEnvArgs(input.check.manifest.env ?? {}),
    input.check.image,
    ...(input.command ?? []),
  ];
  return {
    dockerBinary: input.check.dockerBinary,
    args,
    workspaceMount: {
      hostPath: input.check.manifest.workspaceRoot,
      containerPath: DEFAULT_SANDBOX_WORKSPACE,
      mode: "read_only",
    },
    artifactMount: {
      hostPath: input.check.profile.artifactImport.importRoot,
      containerPath: DEFAULT_SANDBOX_ARTIFACTS,
    },
    networkMode: "none",
    env: input.check.manifest.env ?? {},
    secretEnvNames: Object.keys(input.check.manifest.secretEnvRefs ?? {}),
  };
}

function buildDockerSandboxProfile(input: {
  readonly backendVerified: boolean;
  readonly artifactImportRoot: string;
  readonly artifactImportVerified: boolean;
  readonly networkPolicy: LingSandboxNetworkPolicy;
  readonly networkPolicyVerified: boolean;
}): LingSandboxProfile {
  return {
    schemaVersion: 1,
    id: DEFAULT_PROFILE_ID,
    displayName: "Docker sandbox",
    backendKind: "docker",
    capabilities: [
      "process_isolation",
      "filesystem_isolation",
      "network_policy",
      "artifact_export",
      "resource_limits",
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

function buildDockerSandboxManifest(input: {
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

function resolveArtifactImportRoot(workspaceRoot: string, configuredRoot: string | undefined): string {
  if (!configuredRoot?.trim()) {
    return join(workspaceRoot, ".ling", "artifacts", "sandbox", "docker");
  }
  return isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(workspaceRoot, configuredRoot);
}

function isInsidePath(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function safeDockerCommand(
  runner: DockerSandboxCommandRunner,
  file: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly result?: DockerSandboxCommandResult }> {
  try {
    return { ok: true, result: await runner(file, args) };
  } catch {
    return { ok: false };
  }
}

async function runDockerCommand(file: string, args: readonly string[]): Promise<DockerSandboxCommandResult> {
  const result = await execFileAsync(file, [...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function mountArg(
  source: string,
  target: string,
  mode: "read_only" | "read_write",
): string {
  const readonlySuffix = mode === "read_only" ? ",readonly" : "";
  return `type=bind,source=${source},target=${target}${readonlySuffix}`;
}

function dockerResourceArgs(check: DockerSandboxBackendCheck): readonly string[] {
  const args: string[] = [];
  if (check.resourceLimits?.cpus !== undefined) {
    args.push("--cpus", String(check.resourceLimits.cpus));
  }
  if (check.resourceLimits?.memoryMb !== undefined) {
    args.push("--memory", `${check.resourceLimits.memoryMb}m`);
  }
  return args;
}

function dockerEnvArgs(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function readResourceLimits(config: DockerSandboxFeatureConfig): { readonly resourceLimits?: DockerSandboxResourceLimits } {
  const resourceLimits: DockerSandboxResourceLimits = {};
  if (typeof config.cpus === "number" && Number.isFinite(config.cpus) && config.cpus > 0) {
    Object.assign(resourceLimits, { cpus: config.cpus });
  }
  if (typeof config.memoryMb === "number" && Number.isFinite(config.memoryMb) && config.memoryMb > 0) {
    Object.assign(resourceLimits, { memoryMb: config.memoryMb });
  }
  return Object.keys(resourceLimits).length ? { resourceLimits } : {};
}
