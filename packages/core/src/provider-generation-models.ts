import type {
  ProviderApi,
  ProviderCapability,
  ProviderKind,
  ProviderModelOptionCapabilityConfidence,
  ProviderModelOptionCapabilitySource,
} from "./provider-types.js";

export type GenerationModelFamilyId =
  | "openai-images"
  | "google-image"
  | "volcengine-seedream"
  | "volcengine-seedance"
  | "volcengine-jimeng"
  | "stability"
  | "black-forest-labs"
  | "qwen-image"
  | "ideogram"
  | "xai-grok-imagine";

export interface GenerationModelFamilyInference {
  readonly familyId: GenerationModelFamilyId;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly api: Extract<ProviderApi, "media-job">;
  readonly input: readonly ("text" | "image")[];
  readonly capabilities: readonly ProviderCapability[];
  readonly supportedParameters?: readonly string[];
  readonly capabilitySource: ProviderModelOptionCapabilitySource;
  readonly capabilityConfidence: ProviderModelOptionCapabilityConfidence;
}

export interface GenerationModelFamilyContext {
  readonly kind?: ProviderKind;
  readonly providerId?: string;
  readonly api?: ProviderApi;
}

interface GenerationModelFamilyRule {
  readonly familyId: GenerationModelFamilyId;
  readonly modelPattern: RegExp;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly supportedParameters?: readonly string[];
}

const generationFamilyRules: readonly GenerationModelFamilyRule[] = [
  {
    familyId: "openai-images",
    modelPattern: /(?:^|[/_-])(?:gpt-image|dall-e)(?=$|[/_.-])/i,
    ownedBy: "openai",
    capabilities: ["image_generate"],
    supportedParameters: ["size", "n", "response_format"],
  },
  {
    familyId: "google-image",
    modelPattern: /(?:^|[/_-])(?:imagen|nano-banana)(?=$|[/_.-])|(?:^|[/_-])gemini(?:[/_.-].*)?image|image(?:[/_.-].*)?gemini/i,
    ownedBy: "google",
    capabilities: ["image_generate"],
    supportedParameters: ["size", "n"],
  },
  {
    familyId: "volcengine-seedream",
    modelPattern: /(?:^|[/_-])(?:doubao-)?seedream(?=$|[/_.-])/i,
    ownedBy: "volcengine",
    capabilities: ["image_generate", "image_edit"],
    supportedParameters: ["size", "seed", "watermark"],
  },
  {
    familyId: "volcengine-seedance",
    modelPattern: /(?:^|[/_-])(?:doubao-)?seedance(?=$|[/_.-])/i,
    ownedBy: "volcengine",
    capabilities: ["video_generate"],
    supportedParameters: ["ratio", "duration", "watermark"],
  },
  {
    familyId: "volcengine-jimeng",
    modelPattern: /(?:^|[/_-])jimeng(?=$|[/_.-])/i,
    ownedBy: "volcengine",
    capabilities: ["image_generate", "image_edit"],
    supportedParameters: ["size", "seed", "watermark"],
  },
  {
    familyId: "stability",
    modelPattern: /(?:^|[/_-])(?:stable-image|stable-diffusion|sd3|sdxl)(?=$|[/_.-])/i,
    ownedBy: "stability",
    capabilities: ["image_generate"],
    supportedParameters: ["size", "seed"],
  },
  {
    familyId: "black-forest-labs",
    modelPattern: /(?:^|[/_-])flux(?=$|[/_.-])/i,
    ownedBy: "black-forest-labs",
    capabilities: ["image_generate"],
    supportedParameters: ["size", "seed"],
  },
  {
    familyId: "qwen-image",
    modelPattern: /(?:^|[/_-])qwen-image(?=$|[/_.-])/i,
    ownedBy: "alibaba",
    capabilities: ["image_generate", "image_edit"],
    supportedParameters: ["size", "seed", "watermark"],
  },
  {
    familyId: "ideogram",
    modelPattern: /(?:^|[/_-])ideogram(?=$|[/_.-])/i,
    ownedBy: "ideogram",
    capabilities: ["image_generate"],
    supportedParameters: ["size", "seed"],
  },
  {
    familyId: "xai-grok-imagine",
    modelPattern: /(?:^|[/_-])grok-imagine(?=$|[/_.-])/i,
    ownedBy: "xai",
    capabilities: ["image_generate"],
    supportedParameters: ["size"],
  },
];

const bflEditPattern = /(?:^|[/_-])flux(?:[/_.-].*)?(?:kontext|fill)(?=$|[/_.-])/i;

export function inferGenerationModelFamily(
  modelId: string | undefined,
  _context: GenerationModelFamilyContext = {},
): GenerationModelFamilyInference | undefined {
  const normalized = normalizeGenerationModelId(modelId);
  if (!normalized) {
    return undefined;
  }
  const rule = generationFamilyRules.find((entry) => entry.modelPattern.test(normalized));
  if (!rule) {
    return undefined;
  }
  return {
    familyId: rule.familyId,
    displayName: rule.displayName,
    ownedBy: rule.ownedBy,
    api: "media-job",
    input: ["text", "image"],
    capabilities: rule.familyId === "black-forest-labs" && bflEditPattern.test(normalized)
      ? mergeCapabilities(rule.capabilities, ["image_edit"])
      : rule.capabilities,
    supportedParameters: rule.supportedParameters,
    capabilitySource: "model_catalog",
    capabilityConfidence: "known",
  };
}

export function isOpenAIImagesGenerationModel(modelId: string | undefined): boolean {
  return inferGenerationModelFamily(modelId)?.familyId === "openai-images";
}

export function isKnownGenerationModel(modelId: string | undefined): boolean {
  return inferGenerationModelFamily(modelId) !== undefined;
}

export function shouldAutoEnableLiveMediaTransport(input: {
  readonly kind?: ProviderKind;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly api?: ProviderApi;
  readonly capabilities?: readonly string[];
}): boolean {
  if (input.api !== "media-job") {
    return false;
  }
  const family = inferGenerationModelFamily(input.modelId, input);
  if (!family) {
    return false;
  }
  if (family.familyId === "openai-images") {
    return Boolean(input.capabilities?.includes("image_generate")) &&
      (input.kind === "openai" || input.kind === "openai-compatible");
  }
  if (family.familyId === "volcengine-seedream") {
    return Boolean(input.capabilities?.includes("image_generate")) &&
      (input.kind === "seedream" || input.providerId === "seedream");
  }
  if (family.familyId === "volcengine-seedance") {
    return Boolean(input.capabilities?.includes("video_generate")) &&
      (input.kind === "seedance" || input.providerId === "seedance");
  }
  return false;
}

function normalizeGenerationModelId(modelId: string | undefined): string {
  return modelId?.trim().toLowerCase().replace(/[:\s]+/g, "-") ?? "";
}

function mergeCapabilities(
  first: readonly ProviderCapability[],
  second: readonly ProviderCapability[],
): readonly ProviderCapability[] {
  const result: ProviderCapability[] = [];
  for (const capability of [...first, ...second]) {
    if (!result.includes(capability)) {
      result.push(capability);
    }
  }
  return result;
}
