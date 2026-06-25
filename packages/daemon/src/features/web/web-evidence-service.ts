import type {
  ProviderPreset,
  SecretResolver,
} from "@ling-stack/core";
import type { WebSearchResult } from "./web-search-adapters.js";
import { runPublicWebSearch } from "./web-search-adapters.js";
import {
  runProviderWebSearch,
  type ProviderWebSearchSecretStore,
} from "./web-search-service.js";
import {
  extractReadableHtmlText,
  fetchPublicLinkBody,
  normalizeExtractedText,
} from "../channels/materialization/extractors/link-body.js";

const READ_URL_TIMEOUT_MS = 12_000;
const READ_URL_MAX_BYTES = 192_000;
const READ_URL_MAX_CHARS = 4_000;
const READ_URL_MAX_LINKS = 3;
const WEB_SEARCH_MAX_QUERY_ATTEMPTS = 4;
const WEB_SEARCH_DEGRADED_REASON = "web_search backend returned text but no citation/source metadata. This provider or relay may accept the configured protocol without supporting real hosted web search; treat current facts as unverified unless open_url evidence is included.";

export type WebEvidenceContextStatus = "not_applicable" | "available" | "degraded" | "blocked";

export interface WebEvidenceContext {
  readonly status: WebEvidenceContextStatus;
  readonly prompt?: string;
  readonly reason?: string;
  readonly search?: WebSearchResult;
  readonly readUrls?: readonly WebEvidenceReadUrlResult[];
}

export type WebEvidenceProgressEvent =
  | {
      readonly type: "web_search_planned";
      readonly queries: readonly string[];
    }
  | {
      readonly type: "web_search_started";
      readonly query: string;
      readonly attempt: number;
      readonly total: number;
    }
  | {
      readonly type: "web_search_completed";
      readonly query: string;
      readonly attempt: number;
      readonly total: number;
      readonly status: "available" | "degraded" | "blocked";
      readonly sourceCount: number;
      readonly reason?: string;
    }
  | {
      readonly type: "open_url_started";
      readonly url: string;
      readonly attempt: number;
      readonly total: number;
    }
  | {
      readonly type: "open_url_completed";
      readonly url: string;
      readonly attempt: number;
      readonly total: number;
      readonly status: "available" | "blocked";
      readonly finalUrl?: string;
      readonly reason?: string;
    };

export interface BuildWebEvidenceContextInput {
  readonly providerPreset?: ProviderPreset;
  readonly webSearchProviderPresets?: readonly ProviderPreset[];
  readonly providerStore?: ProviderWebSearchSecretStore;
  readonly sourceText: string;
  readonly availableMaterializedUrls?: readonly string[];
  readonly secretResolver: SecretResolver;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly promptHeader?: string;
  readonly promptInstruction?: string;
  readonly onProgress?: (event: WebEvidenceProgressEvent) => void;
}

export interface WebEvidenceReadUrlResult {
  readonly url: string;
  readonly status: "available" | "blocked";
  readonly title?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly finalUrl?: string;
}

export async function buildWebEvidenceContext(input: BuildWebEvidenceContextInput): Promise<WebEvidenceContext> {
  const text = input.sourceText;
  const shouldSearch = shouldRunWebSearchForText(text);
  const availableMaterializedUrls = new Set(input.availableMaterializedUrls ?? []);
  let urlsToRead = shouldReadPublicUrlsForText(text)
    ? extractPublicUrls(text)
      .filter((url) => !availableMaterializedUrls.has(url))
      .slice(0, READ_URL_MAX_LINKS)
    : [];

  if (!shouldSearch && urlsToRead.length === 0) {
    return { status: "not_applicable" };
  }

  const sections: string[] = [];
  let search: WebSearchResult | undefined;
  let webReason: string | undefined;
  if (shouldSearch) {
    const searchContext = await runPlannedProviderWebSearch(input, text);
    if (searchContext.status === "blocked") {
      webReason = searchContext.reason ?? "Current selected Ling provider does not support realtime web search.";
      sections.push(`Web search status: blocked\nReason: ${webReason}`);
    } else if (searchContext.result) {
      search = searchContext.result;
      sections.push(renderWebSearchResult(search));
      if (search.sources.length === 0) {
        webReason = searchContext.reason ?? WEB_SEARCH_DEGRADED_REASON;
        sections.push(`Web search status: degraded\nReason: ${webReason}`);
        urlsToRead = appendBoundedUniqueUrls(urlsToRead, extractPublicUrls(search.text), availableMaterializedUrls, READ_URL_MAX_LINKS);
      }
    }
  }

  const readUrls = urlsToRead.length > 0
    ? await readPublicUrlsForContext({
      urls: urlsToRead,
      fetch: input.fetch,
      resolveHostAddresses: input.resolveHostAddresses,
      timeoutMs: READ_URL_TIMEOUT_MS,
      onProgress: input.onProgress,
    })
    : [];
  if (readUrls.length > 0) {
    sections.push(renderReadUrlResults(readUrls));
  }

  if (sections.length === 0) {
    return { status: "not_applicable" };
  }
  const hasSourceEvidence = Boolean(search && search.sources.length > 0);
  const hasReadUrlEvidence = readUrls.some((item) => item.status === "available");
  return {
    status: hasSourceEvidence || hasReadUrlEvidence
      ? "available"
      : search
        ? "degraded"
        : "blocked",
    prompt: [
      input.promptHeader ?? "Ling web context:",
      input.promptInstruction ?? "Use this web context only as cited evidence for the current reply. Do not claim access to web pages beyond the included results.",
      ...sections,
    ].join("\n"),
    reason: webReason,
    search,
    readUrls,
  };
}

export function prependWebEvidenceContext(prompt: string, context: WebEvidenceContext): string {
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

export function planWebSearchQueries(text: string): string[] {
  const original = normalizeSearchQuery(text);
  if (!original) {
    return [];
  }
  const queries: string[] = [original];
  const topic = extractSearchTopic(original);
  const freshnessIntent = isFreshnessSearchText(original);
  if (freshnessIntent && hasAiSearchTopic(original)) {
    queries.push("AI latest news");
    queries.push("AI news today");
    if (hasCjk(original)) {
      queries.push("今日 AI 新闻");
    }
  }
  if (topic && topic !== original) {
    queries.push(topic);
  }
  if (topic && freshnessIntent) {
    queries.push(`${topic} latest news`);
    queries.push(`${topic} news today`);
    if (hasCjk(original)) {
      queries.push(`${topic} 最新 新闻`);
    }
  }
  if (hasAiSearchTopic(original)) {
    queries.push("AI news today");
    queries.push("latest AI news");
    queries.push("今日 AI 新闻");
  }
  return uniqueQueries(queries).slice(0, WEB_SEARCH_MAX_QUERY_ATTEMPTS);
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

async function runPlannedProviderWebSearch(
  input: BuildWebEvidenceContextInput,
  sourceText: string,
): Promise<{ readonly status: "available" | "degraded" | "blocked"; readonly result?: WebSearchResult; readonly reason?: string }> {
  const queries = planWebSearchQueries(sourceText);
  if (queries.length === 0) {
    return { status: "blocked", reason: "web_search query is empty." };
  }
  emitWebEvidenceProgress(input.onProgress, {
    type: "web_search_planned",
    queries,
  });
  let fallbackResult: WebSearchResult | undefined;
  let lastBlockedReason: string | undefined;
  const attemptedQueries: string[] = [];
  for (const [index, query] of queries.entries()) {
    attemptedQueries.push(query);
    emitWebEvidenceProgress(input.onProgress, {
      type: "web_search_started",
      query,
      attempt: index + 1,
      total: queries.length,
    });
    const searchContext = await runProviderWebSearch({
      providerPreset: input.providerPreset,
      webSearchProviderPresets: input.webSearchProviderPresets,
      providerStore: input.providerStore,
      secretResolver: input.secretResolver,
      query,
      fetch: input.fetch,
    });
    if (searchContext.result) {
      const result = {
        ...searchContext.result,
        queries: [...attemptedQueries],
      };
      if (result.sources.length > 0) {
        emitWebEvidenceProgress(input.onProgress, {
          type: "web_search_completed",
          query,
          attempt: index + 1,
          total: queries.length,
          status: "available",
          sourceCount: result.sources.length,
        });
        return { status: "available", result };
      }
      fallbackResult = result;
      lastBlockedReason = searchContext.reason ?? WEB_SEARCH_DEGRADED_REASON;
    } else {
      lastBlockedReason = searchContext.reason;
    }

    const publicSearchContext = await runPublicSearchFallback({
      query,
      attemptedQueries,
      fetch: input.fetch,
    });
    if (publicSearchContext.result && publicSearchContext.result.sources.length > 0) {
      emitWebEvidenceProgress(input.onProgress, {
        type: "web_search_completed",
        query,
        attempt: index + 1,
        total: queries.length,
        status: "available",
        sourceCount: publicSearchContext.result.sources.length,
        reason: searchContext.reason,
      });
      return { status: "available", result: publicSearchContext.result };
    }
    if (publicSearchContext.result) {
      fallbackResult = fallbackResult ?? publicSearchContext.result;
    }
    if (searchContext.status === "blocked" && !publicSearchContext.result) {
      emitWebEvidenceProgress(input.onProgress, {
        type: "web_search_completed",
        query,
        attempt: index + 1,
        total: queries.length,
        status: "blocked",
        sourceCount: 0,
        reason: publicSearchContext.reason ?? searchContext.reason,
      });
      continue;
    }
    if (!searchContext.result && !publicSearchContext.result) {
      emitWebEvidenceProgress(input.onProgress, {
        type: "web_search_completed",
        query,
        attempt: index + 1,
        total: queries.length,
        status: "degraded",
        sourceCount: 0,
        reason: publicSearchContext.reason ?? searchContext.reason ?? "web_search backend returned no usable result.",
      });
      continue;
    }
    emitWebEvidenceProgress(input.onProgress, {
      type: "web_search_completed",
      query,
      attempt: index + 1,
      total: queries.length,
      status: "degraded",
      sourceCount: 0,
      reason: publicSearchContext.reason ?? searchContext.reason ?? WEB_SEARCH_DEGRADED_REASON,
    });
  }
  if (fallbackResult) {
    return { status: "degraded", result: fallbackResult, reason: lastBlockedReason ?? WEB_SEARCH_DEGRADED_REASON };
  }
  return {
    status: "blocked",
    reason: lastBlockedReason ?? "web_search backend returned no usable result.",
  };
}

async function runPublicSearchFallback(input: {
  readonly query: string;
  readonly attemptedQueries: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}): Promise<{ readonly result?: WebSearchResult; readonly reason?: string }> {
  try {
    const result = await runPublicWebSearch({
      query: input.query,
      fetch: input.fetch,
    });
    return {
      result: {
        ...result,
        queries: [...input.attemptedQueries],
      },
    };
  } catch (error) {
    return {
      reason: `Ling public web search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readPublicUrlsForContext(input: {
  readonly urls: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs: number;
  readonly onProgress?: (event: WebEvidenceProgressEvent) => void;
}): Promise<readonly WebEvidenceReadUrlResult[]> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return input.urls.map((url, index) => {
      emitWebEvidenceProgress(input.onProgress, {
        type: "open_url_started",
        url,
        attempt: index + 1,
        total: input.urls.length,
      });
      emitWebEvidenceProgress(input.onProgress, {
        type: "open_url_completed",
        url,
        attempt: index + 1,
        total: input.urls.length,
        status: "blocked",
        reason: "fetch is not available in this runtime.",
      });
      return {
        url,
        status: "blocked",
        reason: "fetch is not available in this runtime.",
      };
    });
  }
  const results: WebEvidenceReadUrlResult[] = [];
  for (const [index, url] of input.urls.entries()) {
    emitWebEvidenceProgress(input.onProgress, {
      type: "open_url_started",
      url,
      attempt: index + 1,
      total: input.urls.length,
    });
    const fetched = await fetchPublicLinkBody(url, {
      fetch: fetchImpl,
      resolveHostAddresses: input.resolveHostAddresses,
      maxBytes: READ_URL_MAX_BYTES,
      timeoutMs: input.timeoutMs,
      redirectLimit: 3,
    });
    if (!fetched.allowed) {
      emitWebEvidenceProgress(input.onProgress, {
        type: "open_url_completed",
        url,
        attempt: index + 1,
        total: input.urls.length,
        status: "blocked",
        reason: fetched.message,
      });
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
    emitWebEvidenceProgress(input.onProgress, {
      type: "open_url_completed",
      url,
      attempt: index + 1,
      total: input.urls.length,
      status: "available",
      finalUrl: fetched.finalUrl,
    });
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
    result.queries && result.queries.length > 0
      ? [
        "Search queries:",
        ...result.queries.map((query, index) => `- ${index + 1}. ${query}`),
      ].join("\n")
      : undefined,
    result.text ? `Summary:\n${indent(result.text)}` : "Summary: none returned",
    result.sources.length > 0
      ? [
        "Sources:",
        ...result.sources.map((source, index) =>
          `- ${index + 1}. ${source.title ?? source.url} (${source.url})${source.snippet ? `\n  snippet: ${source.snippet}` : ""}`
        ),
      ].join("\n")
      : "Sources: none returned",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderReadUrlResults(results: readonly WebEvidenceReadUrlResult[]): string {
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

function appendBoundedUniqueUrls(
  current: readonly string[],
  next: readonly string[],
  unavailableUrls: ReadonlySet<string>,
  maxCount: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const url of [...current, ...next]) {
    if (seen.has(url) || unavailableUrls.has(url)) {
      continue;
    }
    seen.add(url);
    result.push(url);
    if (result.length >= maxCount) {
      break;
    }
  }
  return result;
}

function emitWebEvidenceProgress(
  onProgress: ((event: WebEvidenceProgressEvent) => void) | undefined,
  event: WebEvidenceProgressEvent,
): void {
  try {
    onProgress?.(event);
  } catch {
    // Web progress is diagnostic UI state; it must not block the actual search.
  }
}

function normalizeSearchQuery(text: string): string {
  return text
    .replace(/[@＠][^\s，。,.!?！？；;:：)）]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

function extractSearchTopic(query: string): string | undefined {
  const topic = query
    .replace(/[@＠][^\s，。,.!?！？；;:：)）]+/gu, " ")
    .replace(/[，。,.!?！？；;:：()[\]（）【】"'`]/gu, " ")
    .replace(/\b(?:web[_ -]?search|search|browse|look up|lookup|find|current|latest|today|yesterday|recent|news|source|sources|citation|citations|url|urls)\b/giu, " ")
    .replace(/(?:查一下|搜索一下|搜一下|查询一下|查找|查网页|搜网页|联网|上网|网页搜索|网络搜索|打开|读取|看看|整理一下|整理一份|整理|汇总一下|汇总|总结一下|总结|梳理一下|梳理|列出|生成|制作|做一份|写一份|今天|今日|昨天|昨日|热门|最新|实时|当前|新闻|动态|来源|链接|带来源|回复|一句话|帮我|给我|请问|请|一下|一下子|一份|关于|的)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (topic.length < 2 || topic === query) {
    return undefined;
  }
  return topic.slice(0, 96);
}

function isFreshnessSearchText(text: string): boolean {
  return /(最新|实时|今天|今日|昨日|昨天|本周|刚刚|现在|当前|新闻|动态|current|latest|today|yesterday|recent|news)/iu.test(text);
}

function hasAiSearchTopic(text: string): boolean {
  return /(?:^|[^A-Za-z0-9])AI(?:$|[^A-Za-z0-9])|人工智能|大模型/iu.test(text);
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function uniqueQueries(values: readonly string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const query = normalizeSearchQuery(value);
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries;
}
