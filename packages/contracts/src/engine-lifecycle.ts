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
  /** Reviewed per-platform sha512 digests for the pinned binary tarball. */
  readonly pinnedIntegrityByPlatform?: Readonly<Record<string, string>>;
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
    pinnedIntegrityByPlatform: {
      "darwin-arm64": "sha512-pDizgOUAtq3/k3AbUFHbaU19WpYKCja+oFpNSTLKrDQj4lTUNSDuTPJip4uQVn2/1EipQdpQrGMOQBVuI1znAA==",
      "darwin-x64": "sha512-lIe+udnguPGzBezkgbkj2Eaz0YqOhNXT7jja136Fj0sXfI+UKNS2icmaK14GcoRAgeVEpDTtC1ftamWBPmD1zg==",
      "linux-x64": "sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==",
      "linux-arm64": "sha512-LL5iTQjyDL4YRX44EWqhIfEQ5uGnmgxkQBJSxjZSeJ8L1Og83pdlzUJW/PRJ76oaVwOVgh6HXwuPEiBNEHU4lg==",
      "win32-x64": "sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg==",
      "win32-arm64": "sha512-Zkzt8HNmB/vOnlDo5D7IOlrt5rHaxYQB7iGbNP7bHcXZtrk6gaD7UriwaieGYJpcf8DqAT/0tqzY4xbs8ZwbmQ==",
    },
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
    pinnedIntegrityByPlatform: {
      "darwin-arm64": "sha512-PHxqWpXJ7ED6ZD+2xNiTfiPoK9Aq5siPMhZ2lLHwA1HB10XluHP4dSJ6YSA24Hb4cD/P3nTlhFMauk2VPdMMNA==",
      "darwin-x64": "sha512-DEMAnoIk6qVaZ7r+o/QsFH532HOO9c6I+0mE2WuTygq5H8Gr7jgzpK7HVB6d1xzAuliu6MEw32G+oo//gYuvqw==",
      "linux-x64": "sha512-dk1lVMt7n+NlYucKM7dLp/PfrK32pa/4oKQkacfazlSj8rG+hkH67wnDnaFG9Gs2al3OjK8PTVHgZ2WGHXoWUg==",
      "linux-arm64": "sha512-yZwDmtXmoZcFcCjCaoznOKqjrjjdQyc6PVuh6brANqQcaKpP+WZGuFlgUjgQh86u8HBybHZBB60WWOumKpO6uQ==",
      "linux-x64-musl": "sha512-/SY8KhtVq5HRIdJu6Ow1ImkAplgL46J88j8vhH5FTZaNPVBjyk4A4yuIFMgyy8dVaNgVXxlpjXIEnfX39uDq5Q==",
      "linux-arm64-musl": "sha512-ymSGc6vv0QCcVQZCC2JG03P/upLraox+iXAG1DfnUU1OZBCIR9QncxINBEp6QgnKbqywwR2/ic3GD8hAz0Tiow==",
      "win32-x64": "sha512-fKXnBqsAPxVeIc20kCdzI4GznhuCJxumy1ZbwkyIfgZRsZXKHzMaayrJ/Ro2O+Dfb/s9rG/gAqGkqJCsA3FgJg==",
      "win32-arm64": "sha512-Gc9o60Ji5RuP6xm7MBJsLUJE/AGymq8HF11idETBANHnLqg4uITD4O3tdOFE0yR7y6zEz2wl5D/7n4NlrY16Yg==",
    },
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
