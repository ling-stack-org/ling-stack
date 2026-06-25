import {
  type ChannelMessage,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { WebSearchResult } from "../web/web-search-adapters.js";
import {
  buildWebEvidenceContext,
  prependWebEvidenceContext,
  type WebEvidenceContext,
  type WebEvidenceContextStatus,
  type WebEvidenceProgressEvent,
  type WebEvidenceReadUrlResult,
} from "../web/web-evidence-service.js";
import type { ProviderWebSearchSecretStore } from "../web/web-search-service.js";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";

export {
  runGoogleInteractionsWebSearch,
  runOpenAiChatCompletionsWebSearch,
  runOpenAiWebSearch,
} from "../web/web-search-adapters.js";
export {
  extractPublicUrls,
  planWebSearchQueries,
  shouldReadPublicUrlsForText,
  shouldRunWebSearchForText,
} from "../web/web-evidence-service.js";

export type ChannelWebContextStatus = WebEvidenceContextStatus;
export type OpenAiWebSearchResult = WebSearchResult;
export type ChannelWebContext = WebEvidenceContext;
export type ReadUrlContextResult = WebEvidenceReadUrlResult;

export interface BuildChannelWebContextInput {
  readonly store: Pick<RunStore, "getProviderPreset"> & Partial<Pick<RunStore, "getProviderSecret" | "hasProviderSecret" | "listProviderPresets">>;
  readonly providerPresetId?: string;
  readonly sourceMessage: Pick<ChannelMessage, "body">;
  readonly turnEnvelope: Pick<LingAgentTurnEnvelope, "body" | "linkPreviews">;
  readonly secretResolver: SecretResolver;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly onProgress?: (event: WebEvidenceProgressEvent) => void;
}

export async function buildChannelWebContext(input: BuildChannelWebContextInput): Promise<ChannelWebContext> {
  return await buildWebEvidenceContext({
    providerPreset: input.providerPresetId ? input.store.getProviderPreset(input.providerPresetId) : undefined,
    webSearchProviderPresets: input.store.listProviderPresets?.({ enabled: true }),
    providerStore: hasProviderSecretLookup(input.store) ? input.store : undefined,
    sourceText: input.sourceMessage.body,
    availableMaterializedUrls: input.turnEnvelope.linkPreviews
      .filter((preview) => preview.materializationStatus === "available")
      .flatMap((preview) => [preview.url, preview.normalizedUrl].filter((url): url is string => Boolean(url))),
    secretResolver: input.secretResolver,
    fetch: input.fetch,
    resolveHostAddresses: input.resolveHostAddresses,
    onProgress: input.onProgress,
    promptHeader: "Ling web context:",
    promptInstruction: "Use this web context only as cited evidence for the current channel reply. Do not claim access to web pages beyond the included results.",
  });
}

export function prependChannelWebContext(prompt: string, context: ChannelWebContext): string {
  return prependWebEvidenceContext(prompt, context);
}

function hasProviderSecretLookup(
  store: BuildChannelWebContextInput["store"],
): store is BuildChannelWebContextInput["store"] & ProviderWebSearchSecretStore {
  return typeof store.getProviderSecret === "function" && typeof store.hasProviderSecret === "function";
}
