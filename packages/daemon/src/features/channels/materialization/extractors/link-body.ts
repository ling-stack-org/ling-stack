import { lookup } from "node:dns/promises";
import type { LingInputExtractor } from "../registry.js";
import { decidePublicLinkMaterializationPolicy, isLocalOrPrivateHost } from "../policy.js";

export const linkBodyExtractorV1: LingInputExtractor = {
  id: "link_body_v1",
  version: "1",
  supportedSourceKinds: ["link_preview"],
  supportedContentKinds: ["html_text", "plain_text"],
  supports(input) {
    return input.sourceKind === "link_preview";
  },
  async materialize(input) {
    const preview = input.linkPreview;
    if (!preview) {
      return {
        status: "blocked",
        contentKind: "html_text",
        errorCode: "missing_link_preview",
        errorMessage: "Link preview record is missing.",
      };
    }
    if (preview.status !== "ready") {
      return {
        status: "blocked",
        contentKind: "html_text",
        errorCode: "link_preview_not_ready",
        errorMessage: preview.errorMessage ?? `Link preview is ${preview.status}.`,
      };
    }
    const fetchImpl = input.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      return {
        status: "blocked",
        contentKind: "html_text",
        errorCode: "fetch_unavailable",
        errorMessage: "Fetch is not available in this runtime.",
      };
    }
    const maxBytes = Math.max(input.maxBytes, 1);
    const maxChars = Math.max(input.maxChars, 1);
    const timeoutMs = Math.max(input.timeoutMs ?? 10_000, 1);
    const redirectLimit = Math.max(input.redirectLimit ?? 3, 0);
    const fetched = await fetchPublicLinkBody(preview.normalizedUrl || preview.url, {
      fetch: fetchImpl,
      resolveHostAddresses: input.resolveHostAddresses,
      maxBytes,
      timeoutMs,
      redirectLimit,
    });
    if (!fetched.allowed) {
      return {
        status: "blocked",
        contentKind: "html_text",
        byteCount: fetched.byteCount,
        policyDecision: fetched.policyDecision,
        errorCode: fetched.reason,
        errorMessage: fetched.message,
      };
    }
    const contentKind = fetched.contentType.includes("html") ? "html_text" : "plain_text";
    const extracted = contentKind === "html_text"
      ? extractReadableHtmlText(fetched.body)
      : normalizeExtractedText(fetched.body);
    const contentText = extracted.slice(0, maxChars);
    const truncated = fetched.truncated || extracted.length > contentText.length;
    return {
      status: "available",
      contentKind,
      contentText,
      byteCount: fetched.byteCount,
      tokenEstimate: estimateTokens(contentText),
      truncated,
      policyDecision: {
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        redirectCount: fetched.redirectCount,
      },
    };
  },
};

export interface FetchPublicLinkBodyOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly redirectLimit: number;
}

export type FetchPublicLinkBodyResult =
  | {
      readonly allowed: true;
      readonly finalUrl: string;
      readonly contentType: string;
      readonly body: string;
      readonly byteCount: number;
      readonly truncated: boolean;
      readonly redirectCount: number;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly message: string;
      readonly byteCount?: number;
      readonly policyDecision?: Record<string, unknown>;
    };

export async function fetchPublicLinkBody(
  initialUrl: string,
  options: FetchPublicLinkBodyOptions,
): Promise<FetchPublicLinkBodyResult> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= options.redirectLimit; redirectCount += 1) {
    const policy = await safeAssertPublicUrlAllowed(currentUrl, options.resolveHostAddresses);
    if (!policy.allowed) {
      return {
        allowed: false,
        reason: policy.reason,
        message: policy.message,
        policyDecision: { url: currentUrl, reason: policy.reason, redirectCount },
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,text/plain,application/json",
          "User-Agent": "LingStackMaterialization/0.1",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            allowed: false,
            reason: "redirect_missing_location",
            message: "Redirect response is missing Location.",
            policyDecision: { url: currentUrl, redirectCount },
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        return {
          allowed: false,
          reason: "http_error",
          message: `Link body fetch failed with HTTP ${response.status}.`,
          policyDecision: { url: currentUrl, status: response.status, redirectCount },
        };
      }
      const contentType = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
      if (!isSupportedLinkBodyContentType(contentType)) {
        return {
          allowed: false,
          reason: "unsupported_content_type",
          message: `Link body content type is not supported: ${contentType}.`,
          policyDecision: { url: currentUrl, contentType, redirectCount },
        };
      }
      const read = await readResponseBody(response, options.maxBytes);
      return {
        allowed: true,
        finalUrl: currentUrl,
        contentType,
        body: read.body,
        byteCount: read.byteCount,
        truncated: read.truncated,
        redirectCount,
      };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "fetch_failed",
        message: error instanceof Error ? error.message : String(error),
        policyDecision: { url: currentUrl, redirectCount },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    allowed: false,
    reason: "redirect_limit",
    message: "Link body fetch exceeded redirect limit.",
    policyDecision: { url: currentUrl, redirectLimit: options.redirectLimit },
  };
}

async function safeAssertPublicUrlAllowed(
  rawUrl: string,
  resolveHostAddresses: ((hostname: string) => Promise<readonly string[]>) | undefined,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string; readonly message: string }> {
  try {
    return await assertPublicUrlAllowed(rawUrl, resolveHostAddresses);
  } catch (error) {
    return {
      allowed: false,
      reason: "dns_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertPublicUrlAllowed(
  rawUrl: string,
  resolveHostAddresses: ((hostname: string) => Promise<readonly string[]>) | undefined,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string; readonly message: string }> {
  const decision = decidePublicLinkMaterializationPolicy(rawUrl);
  if (!decision.allowed) {
    return {
      allowed: false,
      reason: decision.reason ?? "unsafe_url",
      message: publicLinkPolicyMessage(decision.reason ?? "unsafe_url"),
    };
  }
  const hostname = new URL(rawUrl).hostname;
  const addresses = await (resolveHostAddresses ?? defaultResolveHostAddresses)(hostname);
  if (addresses.length === 0) {
    return { allowed: false, reason: "dns_failed", message: `Unable to resolve host: ${hostname}.` };
  }
  for (const address of addresses) {
    if (isLocalOrPrivateHost(address)) {
      return {
        allowed: false,
        reason: "local_or_private_host",
        message: "Link body extraction blocks local or private network targets.",
      };
    }
  }
  return { allowed: true };
}

async function defaultResolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{
  readonly body: string;
  readonly byteCount: number;
  readonly truncated: boolean;
}> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      body: buffer.subarray(0, maxBytes).toString("utf8"),
      byteCount: Math.min(buffer.byteLength, maxBytes),
      truncated: buffer.byteLength > maxBytes,
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (result.value.byteLength > remaining) {
      chunks.push(result.value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    byteCount: total,
    truncated,
  };
}

function isSupportedLinkBodyContentType(contentType: string): boolean {
  return contentType.includes("text/html") ||
    contentType.includes("text/plain") ||
    contentType.includes("application/json");
}

export function extractReadableHtmlText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1] ?? html;
  return normalizeExtractedText(
    body
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/giu, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/giu, " ")
      .replace(/<(?:nav|footer|form|aside)\b[\s\S]*?<\/(?:nav|footer|form|aside)>/giu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|section|article|main|h[1-6]|li|tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  );
}

export function normalizeExtractedText(value: string): string {
  return decodeHtmlEntities(value)
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[ \t\f\v]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function publicLinkPolicyMessage(reason: string): string {
  switch (reason) {
    case "unsupported_protocol":
      return "Only http and https links can be materialized.";
    case "local_or_private_host":
      return "Link body extraction blocks local or private network targets.";
    case "unsafe_url":
      return "Link URL is not safe to materialize.";
    default:
      return "Link URL is not allowed for materialization.";
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
