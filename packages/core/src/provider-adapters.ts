import type { ProviderApi, ProviderKind, ProviderModelOption } from "./provider-types.js";

export type ProviderAdapterMediaKind = "seedream" | "seedance" | "jimeng";

export interface ProviderAdapterInput {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
}

const endpointSuffixes = [
  "/chat/completions",
  "/contents/generations/tasks",
  "/images/generations",
  "/responses",
  "/messages",
  "/models",
];

const builtinMediaModelOptions: Record<ProviderAdapterMediaKind, readonly ProviderModelOption[]> = {
  seedream: [
    { id: "doubao-seedream-5-0-260128", displayName: "Doubao Seedream 5.0", ownedBy: "volcengine" },
  ],
  seedance: [
    { id: "doubao-seedance-1-0-pro-250528", displayName: "Doubao Seedance 1.0 Pro", ownedBy: "volcengine" },
  ],
  jimeng: [
    { id: "jimeng-image", displayName: "Jimeng Image", ownedBy: "volcengine" },
  ],
};

export function providerMediaKind(input: Pick<ProviderAdapterInput, "kind" | "providerId">): ProviderAdapterMediaKind | undefined {
  if (input.kind === "seedream" || input.kind === "seedance" || input.kind === "jimeng") {
    return input.kind;
  }
  if (input.providerId === "seedream" || input.providerId === "seedance" || input.providerId === "jimeng") {
    return input.providerId;
  }
  return undefined;
}

export function builtinMediaModelCandidates(kind: ProviderAdapterMediaKind | undefined): readonly ProviderModelOption[] {
  return kind ? builtinMediaModelOptions[kind] : [];
}

export function normalizeProviderBaseUrlForAdapter(input: Pick<ProviderAdapterInput, "api" | "kind" | "baseUrl">): string {
  const rawBaseUrl = input.baseUrl?.trim() || defaultProviderBaseUrl(input);
  const withoutTrailingSlash = rawBaseUrl.replace(/\/+$/, "");
  try {
    const url = new URL(withoutTrailingSlash);
    let pathname = url.pathname.replace(/\/+$/, "");
    for (const suffix of endpointSuffixes) {
      if (pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    url.pathname = pathname || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return withoutTrailingSlash;
  }
}

export function isMediaOnlyModelId(modelId: string | undefined): boolean {
  const normalized = normalizeModelIdForProtocol(modelId ?? "");
  return isKnownSeedreamModel(normalized) || isKnownSeedanceModel(normalized) || isKnownJimengModel(normalized);
}

export function filterChatModelOptions(models: readonly ProviderModelOption[]): readonly ProviderModelOption[] {
  return models.filter((model) => !isMediaOnlyModelId(model.id));
}

export function filterMediaModelOptions(
  models: readonly ProviderModelOption[],
  kind: ProviderAdapterMediaKind | undefined,
): readonly ProviderModelOption[] {
  if (!kind) {
    return models.filter((model) => isMediaOnlyModelId(model.id));
  }
  return models.filter((model) => mediaModelKind(model.id) === kind);
}

export function mediaModelKind(modelId: string | undefined): ProviderAdapterMediaKind | undefined {
  const normalized = normalizeModelIdForProtocol(modelId ?? "");
  if (isKnownSeedreamModel(normalized)) {
    return "seedream";
  }
  if (isKnownSeedanceModel(normalized)) {
    return "seedance";
  }
  if (isKnownJimengModel(normalized)) {
    return "jimeng";
  }
  return undefined;
}

function defaultProviderBaseUrl(input: Pick<ProviderAdapterInput, "api" | "kind">): string {
  if (input.api === "anthropic-messages" || input.kind === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function normalizeModelIdForProtocol(modelId: string): string {
  return modelId.toLowerCase().replace(/[:/_.\s]+/g, "-");
}

function isKnownSeedreamModel(normalizedModelId: string): boolean {
  return /(^|-)doubao-seedream(-|$)/.test(normalizedModelId) || /(^|-)seedream(-|$)/.test(normalizedModelId);
}

function isKnownSeedanceModel(normalizedModelId: string): boolean {
  return /(^|-)seedance(-|$)/.test(normalizedModelId);
}

function isKnownJimengModel(normalizedModelId: string): boolean {
  return /(^|-)jimeng(-|$)/.test(normalizedModelId);
}
