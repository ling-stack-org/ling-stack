import {
  type ChannelMessage,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { WebSearchResult } from "../web/web-search-adapters.js";
import { runProviderWebSearch } from "../web/web-search-service.js";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import {
  extractReadableHtmlText,
  fetchPublicLinkBody,
  normalizeExtractedText,
} from "./materialization/extractors/link-body.js";

const WEB_CONTEXT_TIMEOUT_MS = 12_000;
const READ_URL_MAX_BYTES = 192_000;
const READ_URL_MAX_CHARS = 4_000;
const READ_URL_MAX_LINKS = 3;

export { runOpenAiWebSearch } from "../web/web-search-adapters.js";

export type ChannelWebContextStatus = "not_applicable" | "available" | "blocked";
export type OpenAiWebSearchResult = WebSearchResult;

export interface ChannelWebContext {
  readonly status: ChannelWebContextStatus;
  readonly prompt?: string;
  readonly reason?: string;
  readonly search?: WebSearchResult;
  readonly readUrls?: readonly ReadUrlContextResult[];
}

export interface BuildChannelWebContextInput {
  readonly store: Pick<RunStore, "getProviderPreset">;
  readonly providerPresetId?: string;
  readonly sourceMessage: Pick<ChannelMessage, "body">;
  readonly turnEnvelope: Pick<LingAgentTurnEnvelope, "body" | "linkPreviews">;
  readonly secretResolver: SecretResolver;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export interface ReadUrlContextResult {
  readonly url: string;
  readonly status: "available" | "blocked";
  readonly title?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly finalUrl?: string;
}

export async function buildChannelWebContext(input: BuildChannelWebContextInput): Promise<ChannelWebContext> {
  const text = input.sourceMessage.body;
  const shouldSearch = shouldRunWebSearchForText(text);
  const urlsToRead = shouldReadPublicUrlsForText(text)
    ? extractPublicUrls(text)
      .filter((url) => !input.turnEnvelope.linkPreviews.some((preview) =>
        preview.materializationStatus === "available" &&
        (preview.url === url || preview.normalizedUrl === url)
      ))
      .slice(0, READ_URL_MAX_LINKS)
    : [];

  if (!shouldSearch && urlsToRead.length === 0) {
    return { status: "not_applicable" };
  }

  const sections: string[] = [];
  let search: WebSearchResult | undefined;
  let searchBlockedReason: string | undefined;
  if (shouldSearch) {
    const searchContext = await runProviderWebSearch({
      providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
      secretResolver: input.secretResolver,
      query: text,
      fetch: input.fetch,
      timeoutMs: WEB_CONTEXT_TIMEOUT_MS,
    });
    if (searchContext.status === "blocked") {
      searchBlockedReason = searchContext.reason ?? "Current selected Ling provider does not support realtime web search.";
      sections.push(`Web search status: blocked\nReason: ${searchBlockedReason}`);
    } else if (searchContext.result) {
      search = searchContext.result;
      sections.push(renderWebSearchResult(search));
    }
  }

  const readUrls = urlsToRead.length > 0
    ? await readPublicUrlsForContext({
      urls: urlsToRead,
      fetch: input.fetch,
      resolveHostAddresses: input.resolveHostAddresses,
      timeoutMs: WEB_CONTEXT_TIMEOUT_MS,
    })
    : [];
  if (readUrls.length > 0) {
    sections.push(renderReadUrlResults(readUrls));
  }

  if (sections.length === 0) {
    return { status: "not_applicable" };
  }
  return {
    status: search || readUrls.some((item) => item.status === "available") ? "available" : "blocked",
    prompt: [
      "Ling web context:",
      "Use this web context only as cited evidence for the current channel reply. Do not claim access to web pages beyond the included results.",
      ...sections,
    ].join("\n"),
    reason: searchBlockedReason,
    search,
    readUrls,
  };
}

export function prependChannelWebContext(prompt: string, context: ChannelWebContext): string {
  if (!context.prompt) {
    return prompt;
  }
  return `${context.prompt}\n\n${prompt}`;
}

export function shouldRunWebSearchForText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (/(web[_ -]?search|search\s+(?:the\s+)?web|browse\s+(?:the\s+)?web|联网|上网|网页搜索|网络搜索|搜索一下|搜一下|查一下|查询一下|查网页|搜网页)/iu.test(normalized)) {
    return true;
  }
  return /(最新|实时|今天|昨日|昨天|本周|刚刚|现在|当前|新闻|动态|current|latest|today|yesterday|recent|news)/iu.test(normalized) &&
    /(查|搜索|查询|确认|验证|新闻|动态|版本|价格|政策|法规|官网|网页|网上|互联网|web|online|internet|news|source|citation)/iu.test(normalized);
}

export function shouldReadPublicUrlsForText(text: string): boolean {
  return extractPublicUrls(text).length > 0 &&
    /(open[_ -]?url|read[_ -]?url|打开|读取|读一下|看看|总结|概括|提取|分析|open|read|summari[sz]e|extract|analy[sz]e|what.*about)/iu.test(text);
}

export function extractPublicUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const matcher = /\bhttps?:\/\/[^\s<>"'`，。；;）)\]]+/giu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const url = stripTrailingUrlPunctuation(match[0] ?? "");
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function readPublicUrlsForContext(input: {
  readonly urls: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs: number;
}): Promise<readonly ReadUrlContextResult[]> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return input.urls.map((url) => ({
      url,
      status: "blocked",
      reason: "fetch is not available in this runtime.",
    }));
  }
  const results: ReadUrlContextResult[] = [];
  for (const url of input.urls) {
    const fetched = await fetchPublicLinkBody(url, {
      fetch: fetchImpl,
      resolveHostAddresses: input.resolveHostAddresses,
      maxBytes: READ_URL_MAX_BYTES,
      timeoutMs: input.timeoutMs,
      redirectLimit: 3,
    });
    if (!fetched.allowed) {
      results.push({
        url,
        status: "blocked",
        reason: fetched.message,
      });
      continue;
    }
    const text = (fetched.contentType.includes("html")
      ? extractReadableHtmlText(fetched.body)
      : normalizeExtractedText(fetched.body)).slice(0, READ_URL_MAX_CHARS);
    results.push({
      url,
      status: "available",
      finalUrl: fetched.finalUrl,
      text,
    });
  }
  return results;
}

function renderWebSearchResult(result: WebSearchResult): string {
  return [
    "Web search result:",
    `Provider: ${result.provider.displayName} (${result.provider.adapterId})`,
    `Query: ${result.query}`,
    result.text ? `Summary:\n${indent(result.text)}` : "Summary: none returned",
    result.sources.length > 0
      ? [
        "Sources:",
        ...result.sources.map((source, index) =>
          `- ${index + 1}. ${source.title ?? source.url} (${source.url})${source.snippet ? `\n  snippet: ${source.snippet}` : ""}`
        ),
      ].join("\n")
      : "Sources: none returned",
  ].join("\n");
}

function renderReadUrlResults(results: readonly ReadUrlContextResult[]): string {
  return [
    "Open URL/read URL results:",
    ...results.map((result, index) => [
      `- ${index + 1}. ${result.url} (${result.status})`,
      result.finalUrl && result.finalUrl !== result.url ? `  finalUrl: ${result.finalUrl}` : undefined,
      result.reason ? `  reason: ${result.reason}` : undefined,
      result.text ? `  text:\n${indent(result.text)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.，。；;:]+$/u, "");
}

function indent(value: string): string {
  return value.split(/\r?\n/u).map((line) => `  ${line}`).join("\n");
}
