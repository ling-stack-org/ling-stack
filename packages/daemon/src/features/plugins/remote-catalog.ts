import { verify } from "node:crypto";
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

export const DEFAULT_PLUGIN_CATALOG_URL = "https://github.com/ling-stack-org/ling-stack/releases/latest/download/catalog.json";
export const DEFAULT_PLUGIN_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7ua9pbZ24GNj4qwssYOMEiwu7ypghh3pzluiMAX2xXw=
-----END PUBLIC KEY-----`;

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
  if (!/^https:\/\//u.test(url)) throw new Error("Plugin catalog URL must use HTTPS.");
  const response = await (options.fetchImpl ?? fetch)(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Plugin catalog request failed with HTTP ${response.status}.`);
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new Error("Plugin catalog exceeds the configured size limit.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Plugin catalog exceeds the configured size limit.");
  let catalog: LingPluginCatalog;
  try {
    catalog = JSON.parse(text) as LingPluginCatalog;
  } catch (error) {
    throw new Error(`Plugin catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateLingPluginCatalog(catalog);
  const publicKey = options.publicKey
    ?? process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY
    ?? (url === DEFAULT_PLUGIN_CATALOG_URL ? DEFAULT_PLUGIN_CATALOG_PUBLIC_KEY : undefined);
  if (!publicKey) return { catalog, url, signatureVerified: false };
  const signatureUrl = options.signatureUrl ?? `${url.slice(0, url.lastIndexOf("/") + 1)}catalog.sig`;
  const signatureResponse = await (options.fetchImpl ?? fetch)(signatureUrl, { redirect: "error" });
  if (!signatureResponse.ok) throw new Error("Plugin catalog signature is unavailable.");
  const encodedSignature = (await signatureResponse.text()).trim().replace(/^ed25519:/u, "");
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64) throw new Error("Plugin catalog signature is invalid.");
  if (!verify(null, Buffer.from(text, "utf8"), publicKey, signature)) {
    throw new Error("Plugin catalog signature verification failed.");
  }
  return { catalog, url, signatureVerified: true };
}

export function selectOfficialPluginArtifact(input: {
  readonly catalog: LingPluginCatalog;
  readonly pluginId: string;
  readonly platform: PluginArtifactPlatform;
  readonly arch: PluginArtifactArchitecture;
  readonly channel?: PluginArtifactChannel;
  readonly version?: string;
}): LingPluginArtifactDescriptor {
  const plugin = input.catalog.plugins.find((candidate) => candidate.pluginId === input.pluginId);
  if (!plugin) throw new Error(`Plugin is not present in the official catalog: ${input.pluginId}`);
  const channel = input.channel ?? "stable";
  const version = input.version ?? plugin.latestStableVersion;
  const artifact = plugin.artifacts.find((candidate) => candidate.platform === input.platform
    && candidate.arch === input.arch
    && candidate.channel === channel
    && candidate.version === version);
  if (!artifact) {
    throw new Error(`No ${channel} artifact is available for ${input.pluginId} ${version} on ${input.platform}/${input.arch}.`);
  }
  return artifact;
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
