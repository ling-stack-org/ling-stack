import type { LingPluginPackageManifest } from "./manifest.js";

export const pluginCatalogSchemaVersion = 1 as const;
export const pluginArtifactPlatforms = ["darwin", "linux", "win32"] as const;
export const pluginArtifactArchitectures = ["arm64", "x64", "ia32", "universal"] as const;
export const pluginArtifactChannels = ["stable", "beta", "dev"] as const;

export type PluginArtifactPlatform = (typeof pluginArtifactPlatforms)[number];
export type PluginArtifactArchitecture = (typeof pluginArtifactArchitectures)[number];
export type PluginArtifactChannel = (typeof pluginArtifactChannels)[number];

export interface LingPluginArtifactDescriptor {
  readonly artifactId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly platform: PluginArtifactPlatform;
  readonly arch: PluginArtifactArchitecture;
  readonly channel: PluginArtifactChannel;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signature?: string;
  readonly runtimeChecksumSignature?: string;
  readonly minLingVersion?: string;
  readonly maxLingVersion?: string;
  readonly rollbackAllowed?: boolean;
}

export interface LingPluginCatalogEntry {
  readonly pluginId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly license?: string;
  readonly trustSummary: string;
  readonly latestStableVersion: string;
  readonly manifest: Pick<LingPluginPackageManifest, "contributions" | "requiredSecrets" | "defaultApprovals" | "healthChecks">;
  readonly artifacts: readonly LingPluginArtifactDescriptor[];
}

export interface LingPluginCatalog {
  readonly schemaVersion: typeof pluginCatalogSchemaVersion;
  readonly generatedAt: string;
  readonly source: {
    readonly repository: string;
    readonly releaseTag: string;
    readonly sourceSha?: string;
  };
  readonly plugins: readonly LingPluginCatalogEntry[];
}

const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function validateLingPluginArtifactDescriptor(artifact: LingPluginArtifactDescriptor): void {
  assertNonEmpty(artifact.artifactId, "artifact.artifactId");
  assertNonEmpty(artifact.pluginId, "artifact.pluginId");
  assertSemver(artifact.version, "artifact.version");
  assertEnum(artifact.platform, pluginArtifactPlatforms, "artifact.platform");
  assertEnum(artifact.arch, pluginArtifactArchitectures, "artifact.arch");
  assertEnum(artifact.channel, pluginArtifactChannels, "artifact.channel");
  if (!/^https:\/\//u.test(artifact.url)) {
    throw new Error("artifact.url must use HTTPS.");
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    throw new Error("artifact.sizeBytes must be a positive integer.");
  }
  if (!sha256Pattern.test(artifact.sha256)) {
    throw new Error("artifact.sha256 must be a lowercase SHA-256 digest.");
  }
  if (artifact.signature !== undefined && !/^ed25519:[A-Za-z0-9+/=_-]+$/u.test(artifact.signature)) {
    throw new Error("artifact.signature must use the ed25519:<payload> format.");
  }
  if (artifact.runtimeChecksumSignature !== undefined && !/^ed25519:[A-Za-z0-9+/=]+$/u.test(artifact.runtimeChecksumSignature)) {
    throw new Error("artifact.runtimeChecksumSignature must use the ed25519:<payload> format.");
  }
  if (artifact.minLingVersion !== undefined) assertSemver(artifact.minLingVersion, "artifact.minLingVersion");
  if (artifact.maxLingVersion !== undefined) assertSemver(artifact.maxLingVersion, "artifact.maxLingVersion");
  if (artifact.rollbackAllowed !== undefined && typeof artifact.rollbackAllowed !== "boolean") throw new Error("artifact.rollbackAllowed must be a boolean.");
}

export function validateLingPluginCatalog(catalog: LingPluginCatalog): void {
  if (catalog.schemaVersion !== pluginCatalogSchemaVersion) {
    throw new Error(`Unsupported plugin catalog schema version: ${String(catalog.schemaVersion)}`);
  }
  assertNonEmpty(catalog.generatedAt, "catalog.generatedAt");
  assertNonEmpty(catalog.source.repository, "catalog.source.repository");
  assertNonEmpty(catalog.source.releaseTag, "catalog.source.releaseTag");
  if (!Array.isArray(catalog.plugins)) throw new Error("catalog.plugins must be an array.");
  const ids = new Set<string>();
  for (const plugin of catalog.plugins) {
    assertNonEmpty(plugin.pluginId, "plugin.pluginId");
    if (ids.has(plugin.pluginId)) throw new Error(`Duplicate plugin catalog entry: ${plugin.pluginId}`);
    ids.add(plugin.pluginId);
    assertNonEmpty(plugin.displayName, "plugin.displayName");
    assertNonEmpty(plugin.trustSummary, "plugin.trustSummary");
    assertSemver(plugin.latestStableVersion, "plugin.latestStableVersion");
    if (!Array.isArray(plugin.artifacts) || plugin.artifacts.length === 0) {
      throw new Error(`Plugin ${plugin.pluginId} must declare at least one artifact.`);
    }
    const artifactIds = new Set<string>();
    for (const artifact of plugin.artifacts) {
      validateLingPluginArtifactDescriptor(artifact);
      if (artifact.pluginId !== plugin.pluginId) throw new Error(`Artifact ${artifact.artifactId} belongs to another plugin.`);
      if (artifactIds.has(artifact.artifactId)) throw new Error(`Duplicate artifact: ${artifact.artifactId}`);
      artifactIds.add(artifact.artifactId);
    }
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
}

function assertSemver(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, field);
  if (!semverPattern.test(value)) throw new Error(`${field} must be semver-compatible.`);
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (!values.includes(value as T)) throw new Error(`${field} must be one of: ${values.join(", ")}`);
}
