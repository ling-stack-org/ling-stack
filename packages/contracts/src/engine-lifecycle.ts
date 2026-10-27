/**
 * Managed engine lifecycle (execution-engine-managed-lifecycle): discovery of
 * existing installations and managed downloads of pinned engine packages.
 */

import { isExternalExecutionEngineId, type ExternalExecutionEngineId } from "./execution-engines.js";

export interface ManagedEnginePackage {
  readonly engineId: ExternalExecutionEngineId;
  readonly packageName: string;
  /** Exact package version downloaded for managed installs. */
  readonly pinnedVersion: string;
  /** Oldest version accepted when scanning an existing installation. */
  readonly minSupported: string;
  /** Newest version verified against Ling's wire protocol. */
  readonly maxVerified: string;
  /** Whether this engine supports managed install in this release. */
  readonly installable: boolean;
  /** Default command name resolved during discovery. */
  readonly commandName: string;
  /** Shown when the engine is not installable in this release. */
  readonly manualGuidance?: string;
  readonly install?: ManagedEngineInstallLayout;
}

/** How a managed package tarball maps onto the executable on disk. */
export interface ManagedEngineInstallLayout {
  /** npm package that carries the platform binary (may differ from packageName). */
  readonly binaryPackageName: (platformKey: string) => string;
  /** npm version of the platform package (codex suffixes the platform key). */
  readonly binaryVersion: (pinnedVersion: string, platformKey: string) => string;
  /** Tarball-internal path of the executable for the target triple. */
  readonly binaryPath: (targetTriple: string) => string;
}

export const MANAGED_ENGINE_PACKAGES: readonly ManagedEnginePackage[] = [
  {
    engineId: "codex-app-server",
    packageName: "@openai/codex",
    pinnedVersion: "0.164.0",
    minSupported: "0.125.0",
    maxVerified: "0.164.0",
    installable: true,
    commandName: "codex",
    install: {
      binaryPackageName: () => "@openai/codex",
      binaryVersion: (pinnedVersion, platformKey) => pinnedVersion + "-" + platformKey,
      binaryPath: (targetTriple) => "package/vendor/" + targetTriple + "/bin/codex",
    },
  },
  {
    engineId: "claude-agent-sdk",
    packageName: "@anthropic-ai/claude-code",
    pinnedVersion: "2.1.311",
    minSupported: "2.0.0",
    maxVerified: "2.1.311",
    installable: true,
    commandName: "claude",
    install: {
      binaryPackageName: (platformKey) => "@anthropic-ai/claude-code-" + platformKey,
      binaryVersion: (pinnedVersion) => pinnedVersion,
      binaryPath: () => "package/claude",
    },
  },
  {
    engineId: "kimi-acp",
    packageName: "",
    pinnedVersion: "",
    minSupported: "",
    maxVerified: "",
    installable: false,
    commandName: "kimi",
    manualGuidance: "Kimi CLI 不走 npm 分发；请按 Kimi 官方指引安装后在档案中指定可执行文件路径。",
  },
  {
    engineId: "openclaw-acp",
    packageName: "",
    pinnedVersion: "",
    minSupported: "",
    maxVerified: "",
    installable: false,
    commandName: "openclaw",
    manualGuidance: "OpenClaw 是独立网关；请按其官方指引部署后在档案中指定网关地址与凭据。",
  },
];

export function getManagedEnginePackage(engineId: ExternalExecutionEngineId): ManagedEnginePackage | undefined {
  return MANAGED_ENGINE_PACKAGES.find((entry) => entry.engineId === engineId);
}

export type EngineDiscoveryStatus = "detected" | "not_found" | "unsupported";

export interface EngineDiscoveryCandidate {
  readonly engineId: ExternalExecutionEngineId;
  readonly status: EngineDiscoveryStatus;
  readonly executablePath?: string;
  readonly version?: string;
  readonly digest?: string;
  readonly installable: boolean;
  readonly manualGuidance?: string;
}

export interface EngineDiscoveryReport {
  readonly checkedAt: string;
  readonly candidates: readonly EngineDiscoveryCandidate[];
}

export function isEngineDiscoveryReport(value: unknown): value is EngineDiscoveryReport {
  return typeof value === "object" && value !== null && Array.isArray((value as EngineDiscoveryReport).candidates);
}

export type ManagedInstallPhase = "idle" | "downloading" | "verifying" | "installed" | "failed";

export interface ManagedInstallStatus {
  readonly engineId: ExternalExecutionEngineId;
  readonly phase: ManagedInstallPhase;
  readonly version?: string;
  readonly executablePath?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

export function isManagedEngineInstallRequest(value: unknown): value is { readonly expectedRevision?: number } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isManagedInstallableEngineId(value: unknown): value is ExternalExecutionEngineId {
  return isExternalExecutionEngineId(value) && getManagedEnginePackage(value)?.installable === true;
}
