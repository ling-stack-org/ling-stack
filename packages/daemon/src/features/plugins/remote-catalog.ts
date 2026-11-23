import { verify } from "node:crypto";
import { comparePluginVersions } from "@ling-stack/contracts";
import { OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY } from "@ling-stack/core/official-plugin-runtime";
import { readFile } from "node:fs/promises";
import type {
  LingPluginArtifactDescriptor,
  LingPluginCatalog,
  LingPluginCatalogEntry,
  PluginArtifactArchitecture,
  PluginArtifactChannel,
  PluginArtifactPlatform,
} from "@ling-stack/plugin-sdk";
import { validateLingPluginCatalog } from "@ling-stack/plugin-sdk";
import { downloadPluginBytes } from "./plugin-download.js";

export { comparePluginVersions };

export const DEFAULT_PLUGIN_CATALOG_URL =
  "https://raw.githubusercontent.com/ling-stack-org/ling-stack/refs/heads/official-plugin-catalog/catalog.json";

export interface PluginCatalogFetchOptions {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly signatureUrl?: string;
  readonly publicKey?: string;
}

export async function fetchOfficialPluginCatalog(options: PluginCatalogFetchOptions = {}): Promise<{
  readonly catalog: LingPluginCatalog;
  readonly url: string;
  readonly signatureVerified: boolean;
}> {
  const catalogFile = process.env.LING_PLUGIN_CATALOG_FILE;
  if (catalogFile) {
    const text = await readFile(catalogFile, "utf8");
    let catalog: LingPluginCatalog;
    try {
      catalog = JSON.parse(text) as LingPluginCatalog;
    } catch (error) {
      throw new Error(`Plugin catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateLingPluginCatalog(catalog);
    return { catalog, url: `file://${catalogFile}`, signatureVerified: false };
  }
  const url = options.url ?? process.env.LING_PLUGIN_CATALOG_URL ?? DEFAULT_PLUGIN_CATALOG_URL;
  const publicKey = options.publicKey
    ?? process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY
    ?? (url === DEFAULT_PLUGIN_CATALOG_URL ? OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY : undefined);
  if (!publicKey) throw new Error("Plugin catalog signature key is not configured.");
  const signatureUrl = options.signatureUrl ?? `${url.slice(0, url.lastIndexOf("/") + 1)}catalog.sig`;
  const [bytes, signatureBytes] = await Promise.all([
    downloadPluginBytes({
      url, maxBytes: options.maxBytes ?? 4 * 1024 * 1024, timeoutMs: 15_000,
      label: "Plugin catalog", fetchImpl: options.fetchImpl,
    }),
    downloadPluginBytes({
      url: signatureUrl, maxBytes: 512, timeoutMs: 15_000,
      label: "Plugin catalog signature", fetchImpl: options.fetchImpl,
    }),
  ]);
  const encodedSignature = signatureBytes.toString("ascii").trim().replace(/^ed25519:/u, "");
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64) throw new Error("Plugin catalog signature is invalid.");
  if (!verify(null, bytes, publicKey, signature)) {
    throw new Error("Plugin catalog signature verification failed.");
  }
  const catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as LingPluginCatalog;
  validateLingPluginCatalog(catalog);
  return { catalog, url, signatureVerified: true };
}

export function selectOfficialPluginArtifact(input: {
  readonly catalog: LingPluginCatalog;
  readonly pluginId: string;
  readonly platform: PluginArtifactPlatform;
  readonly arch: PluginArtifactArchitecture;
  readonly channel?: PluginArtifactChannel;
  readonly version?: string;
  readonly lingVersion?: string;
}): LingPluginArtifactDescriptor {
  const plugin = input.catalog.plugins.find((candidate) => candidate.pluginId === input.pluginId);
  if (!plugin) throw new Error(`Plugin is not present in the official catalog: ${input.pluginId}`);
  const channel = input.channel ?? "stable";
  const compatible = plugin.artifacts.filter((candidate) => candidate.platform === input.platform
    && candidate.arch === input.arch
    && candidate.channel === channel
    && (!input.lingVersion || pluginArtifactSupportsLing(candidate, input.lingVersion)));
  const version = input.version ?? compatible.reduce<string | undefined>((latest, candidate) => {
    if (!latest || comparePluginVersions(candidate.version, latest) > 0) return candidate.version;
    return latest;
  }, undefined);
  const artifact = compatible.find((candidate) => candidate.version === version);
  if (!artifact) {
    throw new Error(`No ${channel} artifact is available for ${input.pluginId} ${version ?? "latest"} on ${input.platform}/${input.arch}.`);
  }
  return artifact;
}

export function pluginArtifactSupportsLing(
  artifact: Pick<LingPluginArtifactDescriptor, "minLingVersion" | "maxLingVersion">,
  lingVersion: string,
): boolean {
  return (!artifact.minLingVersion || comparePluginVersions(lingVersion, artifact.minLingVersion) >= 0)
    && (!artifact.maxLingVersion || comparePluginVersions(lingVersion, artifact.maxLingVersion) <= 0);
}

export function catalogEntryFromManifest(input: {
  readonly manifest: LingPluginCatalogEntry["manifest"];
  readonly pluginId: string;
  readonly displayName: string;
  readonly trustSummary: string;
  readonly latestStableVersion: string;
  readonly artifacts: readonly LingPluginArtifactDescriptor[];
  readonly description?: string;
  readonly homepageUrl?: string;
  readonly license?: string;
}): LingPluginCatalogEntry {
  return {
    pluginId: input.pluginId,
    displayName: input.displayName,
    description: input.description,
    homepageUrl: input.homepageUrl,
    license: input.license,
    trustSummary: input.trustSummary,
    latestStableVersion: input.latestStableVersion,
    manifest: input.manifest,
    artifacts: input.artifacts,
  };
}
