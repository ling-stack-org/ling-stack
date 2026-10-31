import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseMarketplaceIndex, type MarketplaceIndex } from "@ling-stack/contracts";
import { fetch as nativeFetch } from "undici";
import type { DaemonContext } from "../../context.js";
import { preparePinnedPublicHttpRequest, PublicHttpError } from "../../shared/public-http-transport.js";
import { writeJson } from "../../shared/response.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Marketplace indexes are public, DNS-named documents. Direct-IP, loopback
 * and internal-suffix hosts are never valid index locations. This is only a
 * URL-shape check; public-http-transport validates DNS and pins native connect.
 */
function isPublicMarketplaceIndexHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(":")) return false;
  return true;
}

/**
 * Fetch and validate a marketplace index. The index is untrusted: it is
 * parsed with the versioned contract, bounded in size, and only ever points
 * at packs that the review-queue import flow will re-verify by integrity.
 */
export async function handleSkillsMarketplaceInspect(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for marketplace inspect" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const indexUrl = url.searchParams.get("url");
  if (!indexUrl) {
    writeJson(response, 400, { error: "bad_request", message: "url query parameter is required" });
    return;
  }
  let parsedIndexUrl: URL;
  try {
    parsedIndexUrl = new URL(indexUrl);
  } catch {
    writeJson(response, 400, { error: "bad_request", message: "url must be an absolute URL" });
    return;
  }
  if (parsedIndexUrl.protocol !== "https:") {
    writeJson(response, 400, { error: "bad_request", message: "Marketplace indexes must be served over https." });
    return;
  }
  if (parsedIndexUrl.username || parsedIndexUrl.password || !isPublicMarketplaceIndexHost(parsedIndexUrl.hostname)) {
    writeJson(response, 400, { error: "bad_request", message: "Marketplace index hosts must be public DNS names; direct-IP, loopback and internal hosts are not allowed." });
    return;
  }

  // Both the injected Host sender and the native default must consume the
  // pinned dispatcher. Never delegate URL/DNS/redirect policy to global fetch.
  const fetchImpl = context.webFetch ?? (nativeFetch as unknown as typeof globalThis.fetch);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const text = await fetchMarketplaceIndexText(parsedIndexUrl, fetchImpl, signal);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      writeJson(response, 502, { error: "index_not_json", message: "Marketplace index is not valid JSON." });
      return;
    }
    const parsed = parseMarketplaceIndex(raw);
    if (!parsed.ok || !parsed.index) {
      writeJson(response, 422, { error: "index_invalid", message: parsed.reason ?? "Marketplace index is invalid." });
      return;
    }
    const index: MarketplaceIndex = parsed.index;
    writeJson(response, 200, {
      schemaVersion: 1,
      source: parsedIndexUrl.toString(),
      index,
      skills: index.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        latestVersion: skill.versions[skill.versions.length - 1]?.version,
        integrityAlgorithm: "sha256",
      })),
    });
  } catch (error) {
    const unsafe = error instanceof PublicHttpError && ["local_or_private_host", "unsafe_url"].includes(error.code);
    const timedOut = signal.aborted || error instanceof PublicHttpError && error.code === "timeout";
    writeJson(response, error instanceof MarketplaceFetchError ? error.status : unsafe ? 400 : timedOut ? 504 : 502, {
      error: error instanceof MarketplaceFetchError ? error.code : unsafe ? "index_unsafe_url" : timedOut ? "index_fetch_timeout" : "index_fetch_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

class MarketplaceFetchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function fetchMarketplaceIndexText(initialUrl: URL, fetchImpl: typeof globalThis.fetch, signal: AbortSignal): Promise<string> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (current.protocol !== "https:" || current.username || current.password || !isPublicMarketplaceIndexHost(current.hostname)) {
      throw new MarketplaceFetchError(400, "index_unsafe_url", "Marketplace redirects must target public HTTPS DNS names without credentials.");
    }
    const prepared = await preparePinnedPublicHttpRequest(current, {
      signal, redirect: "manual", headers: { Accept: "application/json" },
    }, { timeoutMs: FETCH_TIMEOUT_MS });
    try {
      const fetched = await withinDeadline(prepared.fetch(fetchImpl), signal);
      if (fetched.status >= 300 && fetched.status < 400) {
        await cancelWithinBudget(fetched.body?.cancel());
        const location = fetched.headers.get("location");
        if (!location) throw new MarketplaceFetchError(502, "index_redirect_invalid", "Marketplace redirect is missing Location.");
        if (redirects === MAX_REDIRECTS) throw new MarketplaceFetchError(502, "index_redirect_limit", "Marketplace index exceeded the redirect limit.");
        try { current = new URL(location, current); }
        catch { throw new MarketplaceFetchError(400, "index_unsafe_url", "Marketplace redirect Location is invalid."); }
        continue;
      }
      if (!fetched.ok) {
        await cancelWithinBudget(fetched.body?.cancel());
        throw new MarketplaceFetchError(502, "index_http_error", `Marketplace index fetch failed with HTTP ${fetched.status}.`);
      }
      return await readMarketplaceIndexText(fetched, signal);
    } finally { await prepared.dispose(); }
  }
  throw new MarketplaceFetchError(502, "index_redirect_limit", "Marketplace index exceeded the redirect limit.");
}

async function readMarketplaceIndexText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0, completed = false;
  try {
    while (true) {
      const next = await withinDeadline(reader.read(), signal);
      if (next.done) { completed = true; break; }
      bytes += next.value.byteLength;
      if (bytes > MAX_INDEX_BYTES) throw new MarketplaceFetchError(413, "index_too_large", "Marketplace index exceeds the 2 MiB byte cap.");
      chunks.push(next.value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw new MarketplaceFetchError(502, "index_not_utf8", "Marketplace index is not valid UTF-8."); }
  } finally {
    try { if (!completed) await cancelWithinBudget(reader.cancel()); }
    finally { reader.releaseLock(); }
  }
}

function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

async function cancelWithinBudget(pending?: Promise<void>): Promise<void> {
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("marketplace_body_cleanup_unconfirmed")), CLEANUP_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Shared with the import flow: verifies pack bytes against sha256-<hex> integrity. */
export function verifyMarketplacePackIntegrity(data: Uint8Array, integrity: string): boolean {
  const match = /^sha256-([0-9a-f]{64})$/u.exec(integrity);
  if (!match) return false;
  const digest = createHash("sha256").update(data).digest("hex");
  return digest === match[1];
}
