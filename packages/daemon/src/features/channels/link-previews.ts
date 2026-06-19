import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelLinkPreview, ChannelStoreFacet } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { validateChannelMessageOwner } from "./protocol.js";
import { parseChannelLinkPreviewRequest, type ChannelLinkPreviewRequest } from "./schemas.js";

const CHANNEL_LINK_PREVIEW_TIMEOUT_MS = 5_000;
const CHANNEL_LINK_PREVIEW_MAX_BYTES = 192 * 1024;
const CHANNEL_LINK_PREVIEW_MAX_REDIRECTS = 3;

export async function handleChannelLinkPreviewsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        linkPreviews: store.listChannelLinkPreviews({ channelId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelLinkPreviewRequest(body);
      const messageError = input.messageId ? validateChannelMessageOwner(store, channelId, input.messageId) : undefined;
      if (messageError) {
        writeJson(response, messageError.statusCode, { error: messageError.code, message: messageError.message });
        return;
      }
      const linkPreview = await createOrFetchChannelLinkPreview(store, channelId, input);
      writeJson(response, 201, { linkPreview });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel link previews` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelLinkPreviewItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly linkPreviewId: string; readonly action: "refresh" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelLinkPreview(route.linkPreviewId);
    if (!existing) {
      writeJson(response, 404, { error: "link_preview_not_found", message: `Link preview not found: ${route.linkPreviewId}` });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for link preview refresh` });
      return;
    }
    const metadata = await fetchLinkPreviewMetadata(existing.normalizedUrl);
    const updated = store.updateChannelLinkPreview(
      existing.id,
      metadata,
      new Date().toISOString(),
    );
    writeJson(response, 200, { linkPreview: updated ?? existing });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createOrFetchChannelLinkPreview(
  store: ChannelStoreFacet,
  channelId: string,
  input: ChannelLinkPreviewRequest,
): Promise<ChannelLinkPreview> {
  const normalizedUrl = normalizePreviewUrl(input.url);
  const existing = store
    .listChannelLinkPreviews({ channelId, limit: 500 })
    .find((preview) => preview.normalizedUrl === normalizedUrl);
  if (existing) {
    return existing;
  }

  const metadata = await fetchLinkPreviewMetadata(normalizedUrl);
  return store.createChannelLinkPreview(
    {
      channelId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl,
      title: metadata.title ?? undefined,
      description: metadata.description ?? undefined,
      imageUrl: metadata.imageUrl ?? undefined,
      siteName: metadata.siteName ?? undefined,
      status: metadata.status,
      errorMessage: metadata.errorMessage ?? undefined,
    },
    new Date().toISOString(),
  );
}

export async function fetchLinkPreviewMetadata(url: string): Promise<{
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
  readonly status: ChannelLinkPreview["status"];
  readonly errorMessage?: string | null;
}> {
  try {
    const final = await fetchPreviewHtml(url);
    return {
      ...parseLinkPreviewHtml(final.url, final.html),
      status: "ready",
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: isBlockedPreviewError(error) ? "blocked" : "failed",
      errorMessage: message,
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
    };
  }
}

async function fetchPreviewHtml(initialUrl: string): Promise<{ readonly url: string; readonly html: string }> {
  let currentUrl = normalizePreviewUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= CHANNEL_LINK_PREVIEW_MAX_REDIRECTS; redirectCount += 1) {
    await assertPreviewUrlAllowed(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHANNEL_LINK_PREVIEW_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "LingStackLinkPreview/0.1",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response is missing Location");
        }
        currentUrl = normalizePreviewUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(`Preview fetch failed with HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !contentType.toLowerCase().includes("text/html")) {
        throw new Error(`Preview content type is not HTML: ${contentType}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        return { url: currentUrl, html: await response.text() };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        total += result.value.byteLength;
        if (total > CHANNEL_LINK_PREVIEW_MAX_BYTES) {
          throw new Error(`Preview HTML exceeds ${CHANNEL_LINK_PREVIEW_MAX_BYTES} bytes`);
        }
        chunks.push(result.value);
      }
      return { url: currentUrl, html: Buffer.concat(chunks).toString("utf8") };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Preview exceeded redirect limit");
}

function parseLinkPreviewHtml(url: string, html: string): {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
} {
  const title = readMeta(html, "og:title") ?? readTitle(html);
  const description = readMeta(html, "og:description") ?? readMeta(html, "description");
  const image = readMeta(html, "og:image");
  const siteName = readMeta(html, "og:site_name") ?? new URL(url).hostname;
  return {
    title,
    description,
    imageUrl: image ? new URL(image, url).toString() : null,
    siteName,
  };
}

function readMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]).slice(0, 300);
    }
  }
  return undefined;
}

function readTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]).slice(0, 300) : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

export function normalizePreviewUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https links can be previewed");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

async function assertPreviewUrlAllowed(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    throw new PreviewBlockedError("Link preview blocks localhost hosts");
  }
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${parsed.hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedPreviewAddress(address.address)) {
      throw new PreviewBlockedError(`Link preview blocks private or local address: ${address.address}`);
    }
  }
}

function isBlockedPreviewAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return true;
}

function isBlockedPreviewError(error: unknown): boolean {
  return error instanceof PreviewBlockedError;
}

class PreviewBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewBlockedError";
  }
}
