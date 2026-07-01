import {
  normalizeProviderBaseUrlForAdapter,
  type ProviderPreset,
} from "@ling-stack/core";

const DEFAULT_OPENAI_WEB_SEARCH_MODEL = "gpt-5.5";
const WEB_SEARCH_MAX_OUTPUT_TOKENS = 900;
const WEB_SEARCH_SUMMARY_CHARS = 2_400;
const WEB_SEARCH_MAX_SOURCES = 8;
const PUBLIC_SEARCH_TIMEOUT_MS = 12_000;

type ProviderWebSearchProtocol =
  | "responses-web-search"
  | "openai-chat-completions-search"
  | "google-interactions-search";

interface ProviderWebSearchCompat {
  readonly protocol?: ProviderWebSearchProtocol;
  readonly endpointPath?: string;
}

export interface WebSearchRequest {
  readonly providerPreset: ProviderPreset;
  readonly apiKey: string;
  readonly redactionValues?: readonly string[];
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface OpenAiWebSearchRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly query: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly redactionValues?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface OpenAiChatCompletionsWebSearchRequest extends OpenAiWebSearchRequest {}

export interface GoogleInteractionsWebSearchRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly query: string;
  readonly headers?: Record<string, string>;
  readonly redactionValues?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface PublicWebSearchRequest {
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface WebSearchResult {
  readonly query: string;
  readonly queries?: readonly string[];
  readonly text: string;
  readonly sources: readonly WebSource[];
  readonly provider: {
    readonly adapterId: string;
    readonly providerPresetId: string;
    readonly displayName: string;
  };
}

export interface WebSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface ProviderWebSearchAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: string;
  supportsProvider(provider: ProviderPreset): boolean;
  search(input: WebSearchRequest): Promise<WebSearchResult>;
}

export const openAiResponsesWebSearchAdapter: ProviderWebSearchAdapter = {
  id: "openai-responses-web-search",
  displayName: "Responses-compatible web_search",
  protocol: "responses-web-search",
  supportsProvider(provider) {
    return providerSupportsWebSearchProtocol(provider, "responses-web-search") && provider.api === "openai-responses";
  },
  async search(input) {
    const result = await runOpenAiWebSearch({
      endpoint: buildProviderProtocolEndpoint(input.providerPreset, "/responses"),
      apiKey: input.apiKey,
      model: input.providerPreset.model || DEFAULT_OPENAI_WEB_SEARCH_MODEL,
      query: input.query,
      headers: input.providerPreset.headers,
      authHeader: input.providerPreset.authHeader,
      redactionValues: input.redactionValues ?? [input.apiKey],
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    });
    return {
      ...result,
      provider: {
        adapterId: "openai-responses-web-search",
        providerPresetId: input.providerPreset.id,
        displayName: input.providerPreset.displayName,
      },
    };
  },
};

export const openAiChatCompletionsWebSearchAdapter: ProviderWebSearchAdapter = {
  id: "openai-chat-completions-web-search",
  displayName: "OpenAI-compatible Chat Completions web search",
  protocol: "openai-chat-completions-search",
  supportsProvider(provider) {
    return providerSupportsWebSearchProtocol(provider, "openai-chat-completions-search") && provider.api === "openai-completions";
  },
  async search(input) {
    const result = await runOpenAiChatCompletionsWebSearch({
      endpoint: buildProviderProtocolEndpoint(input.providerPreset, "/chat/completions"),
      apiKey: input.apiKey,
      model: input.providerPreset.model || DEFAULT_OPENAI_WEB_SEARCH_MODEL,
      query: input.query,
      headers: input.providerPreset.headers,
      authHeader: input.providerPreset.authHeader,
      redactionValues: input.redactionValues ?? [input.apiKey],
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    });
    return {
      ...result,
      provider: {
        adapterId: "openai-chat-completions-web-search",
        providerPresetId: input.providerPreset.id,
        displayName: input.providerPreset.displayName,
      },
    };
  },
};

export const googleInteractionsWebSearchAdapter: ProviderWebSearchAdapter = {
  id: "google-interactions-web-search",
  displayName: "Google Gemini Search grounding",
  protocol: "google-interactions-search",
  supportsProvider(provider) {
    return providerSupportsWebSearchProtocol(provider, "google-interactions-search") && provider.api === "google-generative-ai";
  },
  async search(input) {
    const result = await runGoogleInteractionsWebSearch({
      endpoint: buildProviderProtocolEndpoint(input.providerPreset, "/interactions"),
      apiKey: input.apiKey,
      model: input.providerPreset.model,
      query: input.query,
      headers: input.providerPreset.headers,
      redactionValues: input.redactionValues ?? [input.apiKey],
      fetch: input.fetch,
      timeoutMs: input.timeoutMs,
    });
    return {
      ...result,
      provider: {
        adapterId: "google-interactions-web-search",
        providerPresetId: input.providerPreset.id,
        displayName: input.providerPreset.displayName,
      },
    };
  },
};

const providerWebSearchAdapters: readonly ProviderWebSearchAdapter[] = [
  openAiResponsesWebSearchAdapter,
  openAiChatCompletionsWebSearchAdapter,
  googleInteractionsWebSearchAdapter,
];

export function listProviderWebSearchAdapters(): readonly ProviderWebSearchAdapter[] {
  return providerWebSearchAdapters;
}

export function resolveProviderWebSearchAdapter(provider: ProviderPreset | undefined): ProviderWebSearchAdapter | undefined {
  if (!provider) {
    return undefined;
  }
  return providerWebSearchAdapters.find((adapter) => adapter.supportsProvider(provider));
}

export async function runOpenAiWebSearch(input: OpenAiWebSearchRequest): Promise<Omit<WebSearchResult, "provider">> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...input.headers,
      ...(input.authHeader === false ? {} : { Authorization: `Bearer ${input.apiKey}` }),
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
    signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
  });

  if (!response.ok) {
    throw new Error(`Responses API returned HTTP ${response.status}${await safeReadErrorBody(response, input.redactionValues)}`);
  }

  const payload = await response.json() as unknown;
  return {
    query: input.query,
    text: extractResponseText(payload).slice(0, WEB_SEARCH_SUMMARY_CHARS),
    sources: extractWebSources(payload).slice(0, WEB_SEARCH_MAX_SOURCES),
  };
}

export async function runOpenAiChatCompletionsWebSearch(input: OpenAiChatCompletionsWebSearchRequest): Promise<Omit<WebSearchResult, "provider">> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...input.headers,
      ...(input.authHeader === false ? {} : { Authorization: `Bearer ${input.apiKey}` }),
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: input.query }],
      web_search_options: { search_context_size: "low" },
      max_tokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
  });

  if (!response.ok) {
    throw new Error(`Chat Completions API returned HTTP ${response.status}${await safeReadErrorBody(response, input.redactionValues)}`);
  }

  const payload = await response.json() as unknown;
  return {
    query: input.query,
    text: extractChatCompletionsText(payload).slice(0, WEB_SEARCH_SUMMARY_CHARS),
    sources: extractChatCompletionsSources(payload).slice(0, WEB_SEARCH_MAX_SOURCES),
  };
}

export async function runGoogleInteractionsWebSearch(input: GoogleInteractionsWebSearchRequest): Promise<Omit<WebSearchResult, "provider">> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": input.apiKey,
      ...input.headers,
    },
    body: JSON.stringify({
      model: normalizeGoogleModelName(input.model),
      input: input.query,
      tools: [{ type: "google_search" }],
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini API returned HTTP ${response.status}${await safeReadErrorBody(response, input.redactionValues)}`);
  }

  const payload = await response.json() as unknown;
  return {
    query: input.query,
    text: extractGoogleInteractionsText(payload).slice(0, WEB_SEARCH_SUMMARY_CHARS),
    sources: extractGoogleSources(payload).slice(0, WEB_SEARCH_MAX_SOURCES),
  };
}

export async function runPublicWebSearch(input: PublicWebSearchRequest): Promise<WebSearchResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime.");
  }
  const endpoint = `https://r.jina.ai/http://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
      "User-Agent": "Ling-Stack-Web-Search/1.0",
    },
    signal: AbortSignal.timeout(input.timeoutMs ?? PUBLIC_SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Public web search returned HTTP ${response.status}${await safeReadErrorBody(response)}`);
  }

  const markdown = await response.text();
  const sources = extractPublicSearchSources(markdown).slice(0, WEB_SEARCH_MAX_SOURCES);
  return {
    query: input.query,
    text: renderPublicSearchSummary(input.query, sources),
    sources,
    provider: {
      adapterId: "ling-public-web-search",
      providerPresetId: "ling-public-web-search",
      displayName: "Ling public web search",
    },
  };
}

function isOfficialOpenAiResponsesProvider(provider: ProviderPreset): boolean {
  if (provider.api !== "openai-responses" || !provider.enabled) {
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

function providerSupportsWebSearchProtocol(provider: ProviderPreset, protocol: ProviderWebSearchProtocol): boolean {
  if (!provider.enabled || !provider.capabilities.includes("web_search")) {
    return false;
  }
  return resolveProviderWebSearchProtocol(provider) === protocol;
}

function resolveProviderWebSearchProtocol(provider: ProviderPreset): ProviderWebSearchProtocol | undefined {
  const compatProtocol = readProviderWebSearchCompat(provider)?.protocol;
  if (compatProtocol) {
    return compatProtocol;
  }
  if (isOfficialOpenAiResponsesProvider(provider)) {
    return "responses-web-search";
  }
  return undefined;
}

function readProviderWebSearchCompat(provider: ProviderPreset): ProviderWebSearchCompat | undefined {
  const compat = isRecord(provider.compat.webSearch)
    ? provider.compat.webSearch
    : isRecord(provider.compat.web_search)
      ? provider.compat.web_search
      : undefined;
  if (!compat) {
    return undefined;
  }
  return {
    protocol: normalizeWebSearchProtocol(compat.protocol),
    endpointPath: typeof compat.endpointPath === "string"
      ? compat.endpointPath
      : typeof compat.endpoint_path === "string"
        ? compat.endpoint_path
        : undefined,
  };
}

function normalizeWebSearchProtocol(value: unknown): ProviderWebSearchProtocol | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value) {
    case "responses":
    case "openai-responses":
    case "responses-web-search":
    case "xai-responses-web-search":
      return "responses-web-search";
    case "chat-completions":
    case "openai-chat":
    case "openai-chat-completions":
    case "openai-chat-completions-search":
      return "openai-chat-completions-search";
    case "google":
    case "gemini":
    case "google-search":
    case "google-interactions":
    case "google-interactions-search":
      return "google-interactions-search";
    default:
      return undefined;
  }
}

function buildProviderProtocolEndpoint(provider: ProviderPreset, defaultPath: string): string {
  const compatEndpointPath = readProviderWebSearchCompat(provider)?.endpointPath;
  const endpointPath = normalizeEndpointPath(compatEndpointPath) ?? defaultPath;
  return `${normalizeProviderBaseUrlForAdapter(provider)}${endpointPath}`;
}

function normalizeEndpointPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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

function extractChatCompletionsText(payload: unknown): string {
  const textParts: string[] = [];
  for (const choice of readChoiceItems(payload)) {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      continue;
    }
    const content = choice.message.content;
    if (typeof content === "string") {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
    }
  }
  return textParts.join("\n").trim();
}

function extractGoogleInteractionsText(payload: unknown): string {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text.trim();
  }
  const textParts: string[] = [];
  if (isRecord(payload) && Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (!isRecord(step)) {
        continue;
      }
      if (isRecord(step.output) && typeof step.output.text === "string") {
        textParts.push(step.output.text);
      }
      if (Array.isArray(step.content)) {
        for (const content of step.content) {
          if (isRecord(content) && typeof content.text === "string") {
            textParts.push(content.text);
          }
        }
      }
    }
  }
  for (const candidate of readCandidateItems(payload)) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string") {
        textParts.push(part.text);
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
  sources.push(...extractTopLevelSources(payload));
  return uniqueSources(sources);
}

function extractChatCompletionsSources(payload: unknown): WebSource[] {
  const sources: WebSource[] = [];
  for (const choice of readChoiceItems(payload)) {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      continue;
    }
    appendParsedSources(sources, choice.message.annotations);
    appendParsedSources(sources, choice.message.citations);
    appendParsedSources(sources, choice.citations);
    if (Array.isArray(choice.message.content)) {
      for (const part of choice.message.content) {
        if (isRecord(part)) {
          appendParsedSources(sources, part.annotations);
          appendParsedSources(sources, part.citations);
        }
      }
    }
  }
  sources.push(...extractTopLevelSources(payload));
  return uniqueSources(sources);
}

function extractGoogleSources(payload: unknown): WebSource[] {
  const sources: WebSource[] = [];
  if (isRecord(payload) && Array.isArray(payload.steps)) {
    for (const step of payload.steps) {
      if (!isRecord(step)) {
        continue;
      }
      if (isRecord(step.output) && Array.isArray(step.output.annotations)) {
        for (const annotation of step.output.annotations) {
          const parsed = parseWebSource(annotation);
          if (parsed) {
            sources.push(parsed);
          }
        }
      }
      if (Array.isArray(step.content)) {
        for (const content of step.content) {
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
  }
  for (const candidate of readCandidateItems(payload)) {
    if (!isRecord(candidate) || !isRecord(candidate.groundingMetadata)) {
      continue;
    }
    const groundingMetadata = candidate.groundingMetadata;
    if (Array.isArray(groundingMetadata.groundingChunks)) {
      for (const chunk of groundingMetadata.groundingChunks) {
        const parsed = parseWebSource(chunk);
        if (parsed) {
          sources.push(parsed);
        }
      }
    }
  }
  sources.push(...extractTopLevelSources(payload));
  return uniqueSources(sources);
}

function extractPublicSearchSources(markdown: string): WebSource[] {
  const sources: WebSource[] = [];
  const sections = markdown.split(/\n(?=## \[)/u);
  for (const section of sections) {
    const lines = section.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const heading = lines[0] ?? "";
    const headingMatch = /^## \[(.+?)\]\((.+?)\)$/u.exec(heading);
    if (!headingMatch) {
      continue;
    }
    const url = unwrapDuckDuckGoUrl(headingMatch[2] ?? "");
    if (!isPublicHttpUrl(url)) {
      continue;
    }
    const snippet = lines
      .slice(1)
      .map((line) => parsePublicSearchSnippetLine(line, url))
      .find((value) => value && value.length > 0);
    sources.push({
      url,
      title: cleanMarkdownText(headingMatch[1] ?? ""),
      snippet,
    });
  }
  return uniqueSources(sources);
}

function parsePublicSearchSnippetLine(line: string, sourceUrl: string): string | undefined {
  if (!line || line.includes("![Image") || /duckduckgo\.com\/ip3\//u.test(line)) {
    return undefined;
  }
  const linkMatch = /^\[(.+?)\]\((.+?)\)$/u.exec(line);
  if (!linkMatch) {
    return undefined;
  }
  const url = unwrapDuckDuckGoUrl(linkMatch[2] ?? "");
  if (url !== sourceUrl) {
    return undefined;
  }
  const text = cleanMarkdownText(linkMatch[1] ?? "");
  if (!text || looksLikeBareHost(text)) {
    return undefined;
  }
  return text.slice(0, 420);
}

function renderPublicSearchSummary(query: string, sources: readonly WebSource[]): string {
  if (sources.length === 0) {
    return `No public search results with source URLs were returned for: ${query}`;
  }
  return [
    `Public search results for: ${query}`,
    ...sources.map((source, index) =>
      `${index + 1}. ${source.title ?? source.url} - ${source.snippet ?? source.url}`
    ),
  ].join("\n");
}

function unwrapDuckDuckGoUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname === "/l/") {
      const target = parsed.searchParams.get("uddg");
      if (target) {
        return target;
      }
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return hostname !== "duckduckgo.com" && !hostname.endsWith(".duckduckgo.com");
  } catch {
    return false;
  }
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/\*\*/gu, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, "")
    .replace(/\[[^\]]*\]\([^)]+\)/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function looksLikeBareHost(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/iu.test(value.trim());
}

function extractTopLevelSources(payload: unknown): WebSource[] {
  if (!isRecord(payload)) {
    return [];
  }
  const candidates = [
    Array.isArray(payload.sources) ? payload.sources : undefined,
    Array.isArray(payload.citations) ? payload.citations : undefined,
  ].filter((value): value is unknown[] => Boolean(value));
  const sources: WebSource[] = [];
  for (const list of candidates) {
    appendParsedSources(sources, list);
  }
  return sources;
}

function appendParsedSources(sources: WebSource[], values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const item of values) {
    if (typeof item === "string" && item.trim()) {
      sources.push({ url: item.trim() });
      continue;
    }
    const parsed = parseWebSource(item);
    if (parsed) {
      sources.push(parsed);
    }
  }
}

function parseWebSource(value: unknown): WebSource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nested = isRecord(value.url_citation)
    ? value.url_citation
    : isRecord(value.web)
      ? value.web
      : value;
  if (!isRecord(nested)) {
    return undefined;
  }
  const url = typeof nested.url === "string"
    ? nested.url
    : typeof nested.uri === "string"
      ? nested.uri
      : undefined;
  if (!url?.trim()) {
    return undefined;
  }
  return {
    url: url.trim(),
    title: typeof nested.title === "string" ? nested.title : undefined,
    snippet: typeof nested.snippet === "string" ? nested.snippet : undefined,
  };
}

function readOutputItems(payload: unknown): readonly unknown[] {
  return isRecord(payload) && Array.isArray(payload.output) ? payload.output : [];
}

function readChoiceItems(payload: unknown): readonly unknown[] {
  return isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
}

function readCandidateItems(payload: unknown): readonly unknown[] {
  return isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates : [];
}

function normalizeGoogleModelName(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
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

async function safeReadErrorBody(response: Response, redactionValues: readonly string[] = []): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed ? `: ${redactSecretValues(redactSecretLike(trimmed), redactionValues).slice(0, 500)}` : "";
  } catch {
    return "";
  }
}

function redactSecretLike(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_.*-]{6,}\b/gu, "[redacted]");
}

function redactSecretValues(value: string, redactionValues: readonly string[]): string {
  return redactionValues.reduce((current, secret) => {
    if (!secret) {
      return current;
    }
    return current.split(secret).join("[redacted]");
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
