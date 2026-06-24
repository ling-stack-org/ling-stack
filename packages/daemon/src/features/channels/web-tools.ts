import {
  normalizeProviderBaseUrlForAdapter,
  type ChannelMessage,
  type ProviderPreset,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import {
  extractReadableHtmlText,
  fetchPublicLinkBody,
  normalizeExtractedText,
} from "./materialization/extractors/link-body.js";

const DEFAULT_OPENAI_WEB_SEARCH_MODEL = "gpt-5.5";
const DEFAULT_OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
const WEB_CONTEXT_TIMEOUT_MS = 12_000;
const WEB_SEARCH_MAX_OUTPUT_TOKENS = 900;
const WEB_SEARCH_SUMMARY_CHARS = 2_400;
const WEB_SEARCH_MAX_SOURCES = 8;
const READ_URL_MAX_BYTES = 192_000;
const READ_URL_MAX_CHARS = 4_000;
const READ_URL_MAX_LINKS = 3;

export type ChannelWebContextStatus = "not_applicable" | "available" | "blocked";

export interface ChannelWebContext {
  readonly status: ChannelWebContextStatus;
  readonly prompt?: string;
  readonly reason?: string;
  readonly search?: OpenAiWebSearchResult;
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

export interface OpenAiWebSearchRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface OpenAiWebSearchResult {
  readonly query: string;
  readonly text: string;
  readonly sources: readonly WebSource[];
}

export interface WebSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface ReadUrlContextResult {
  readonly url: string;
  readonly status: "available" | "blocked";
  readonly title?: string;
  readonly text?: string;
  readonly reason?: string;
  readonly finalUrl?: string;
}

interface OpenAiWebSearchConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
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
  let search: OpenAiWebSearchResult | undefined;
  let searchBlockedReason: string | undefined;
  if (shouldSearch) {
    const config = resolveOpenAiWebSearchConfig({
      providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
      secretResolver: input.secretResolver,
    });
    if (!config) {
      searchBlockedReason = "OpenAI web search was requested, but env:OPENAI_API_KEY is not configured or the selected OpenAI Responses preset has no usable key.";
      sections.push(`Web search status: blocked\nReason: ${searchBlockedReason}`);
    } else {
      try {
        search = await runOpenAiWebSearch({
          ...config,
          query: text,
          fetch: input.fetch,
          timeoutMs: WEB_CONTEXT_TIMEOUT_MS,
        });
        sections.push(renderOpenAiWebSearchResult(search));
      } catch (error) {
        searchBlockedReason = `OpenAI web search failed: ${safeErrorMessage(error)}`;
        sections.push(`Web search status: blocked\nReason: ${searchBlockedReason}`);
      }
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

export async function runOpenAiWebSearch(input: OpenAiWebSearchRequest): Promise<OpenAiWebSearchResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      reasoning: { effort: "low" },
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: input.query,
      max_output_tokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? WEB_CONTEXT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Responses API returned HTTP ${response.status}${await safeReadErrorBody(response)}`);
  }

  const payload = await response.json() as unknown;
  return {
    query: input.query,
    text: extractResponseText(payload).slice(0, WEB_SEARCH_SUMMARY_CHARS),
    sources: extractWebSources(payload).slice(0, WEB_SEARCH_MAX_SOURCES),
  };
}

function resolveOpenAiWebSearchConfig(input: {
  readonly providerPreset?: ProviderPreset;
  readonly secretResolver: SecretResolver;
}): OpenAiWebSearchConfig | undefined {
  const provider = isOfficialOpenAiResponsesProvider(input.providerPreset) ? input.providerPreset : undefined;
  const providerSecret = provider?.apiKeyRef
    ? input.secretResolver.resolve(provider.apiKeyRef, "provider_api_key")
    : undefined;
  if (provider && providerSecret?.value) {
    return {
      endpoint: `${normalizeProviderBaseUrlForAdapter(provider)}/responses`,
      apiKey: providerSecret.value,
      model: provider.model || DEFAULT_OPENAI_WEB_SEARCH_MODEL,
    };
  }
  const envSecret = input.secretResolver.resolve("env:OPENAI_API_KEY", "provider_api_key");
  if (!envSecret.value) {
    return undefined;
  }
  return {
    endpoint: `${DEFAULT_OPENAI_RESPONSES_BASE_URL}/responses`,
    apiKey: envSecret.value,
    model: DEFAULT_OPENAI_WEB_SEARCH_MODEL,
  };
}

function isOfficialOpenAiResponsesProvider(provider: ProviderPreset | undefined): provider is ProviderPreset {
  if (!provider || provider.api !== "openai-responses" || !provider.enabled) {
    return false;
  }
  if (provider.kind !== "openai") {
    return false;
  }
  if (!provider.baseUrl) {
    return true;
  }
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
    return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
  } catch {
    return false;
  }
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

function renderOpenAiWebSearchResult(result: OpenAiWebSearchResult): string {
  return [
    "Web search result:",
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

function extractResponseText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text.trim();
  }
  const textParts: string[] = [];
  for (const item of readOutputItems(payload)) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }
  return textParts.join("\n").trim();
}

function extractWebSources(payload: unknown): WebSource[] {
  const sources: WebSource[] = [];
  for (const item of readOutputItems(payload)) {
    if (!isRecord(item)) {
      continue;
    }
    if (isRecord(item.action) && Array.isArray(item.action.sources)) {
      for (const source of item.action.sources) {
        const parsed = parseWebSource(source);
        if (parsed) {
          sources.push(parsed);
        }
      }
    }
    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isRecord(content) || !Array.isArray(content.annotations)) {
          continue;
        }
        for (const annotation of content.annotations) {
          const parsed = parseWebSource(annotation);
          if (parsed) {
            sources.push(parsed);
          }
        }
      }
    }
  }
  return uniqueSources(sources);
}

function parseWebSource(value: unknown): WebSource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = isRecord(value.url_citation) ? value.url_citation : value;
  if (!isRecord(nested) || typeof nested.url !== "string" || !nested.url.trim()) {
    return undefined;
  }
  return {
    url: nested.url,
    title: typeof nested.title === "string" ? nested.title : undefined,
    snippet: typeof nested.snippet === "string" ? nested.snippet : undefined,
  };
}

function readOutputItems(payload: unknown): readonly unknown[] {
  return isRecord(payload) && Array.isArray(payload.output) ? payload.output : [];
}

function uniqueSources(sources: readonly WebSource[]): WebSource[] {
  const seen = new Set<string>();
  const unique: WebSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) {
      continue;
    }
    seen.add(source.url);
    unique.push(source);
  }
  return unique;
}

async function safeReadErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed ? `: ${redactSecretLike(trimmed).slice(0, 500)}` : "";
  } catch {
    return "";
  }
}

function safeErrorMessage(error: unknown): string {
  return redactSecretLike(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function redactSecretLike(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_.*-]{6,}\b/gu, "[redacted]");
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.，。；;:]+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function indent(value: string): string {
  return value.split(/\r?\n/u).map((line) => `  ${line}`).join("\n");
}
