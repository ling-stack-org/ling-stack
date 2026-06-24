import {
  normalizeProviderBaseUrlForAdapter,
  type ProviderPreset,
} from "@ling-stack/core";

const DEFAULT_OPENAI_WEB_SEARCH_MODEL = "gpt-5.5";
const WEB_SEARCH_MAX_OUTPUT_TOKENS = 900;
const WEB_SEARCH_SUMMARY_CHARS = 2_400;
const WEB_SEARCH_MAX_SOURCES = 8;

export interface WebSearchRequest {
  readonly providerPreset: ProviderPreset;
  readonly apiKey: string;
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface OpenAiWebSearchRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly query: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface WebSearchResult {
  readonly query: string;
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
  displayName: "OpenAI Responses web_search",
  protocol: "openai-responses",
  supportsProvider(provider) {
    return isOfficialOpenAiResponsesProvider(provider) && provider.capabilities.includes("web_search");
  },
  async search(input) {
    const result = await runOpenAiWebSearch({
      endpoint: `${normalizeProviderBaseUrlForAdapter(input.providerPreset)}/responses`,
      apiKey: input.apiKey,
      model: input.providerPreset.model || DEFAULT_OPENAI_WEB_SEARCH_MODEL,
      query: input.query,
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

const providerWebSearchAdapters: readonly ProviderWebSearchAdapter[] = [
  openAiResponsesWebSearchAdapter,
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
    signal: AbortSignal.timeout(input.timeoutMs ?? 12_000),
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

function redactSecretLike(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_.*-]{6,}\b/gu, "[redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
