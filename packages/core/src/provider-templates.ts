import type { ProviderPresetInput } from "./provider-types.js";

export interface ProviderTemplate extends ProviderPresetInput {
  readonly templateId: string;
  readonly description: string;
}

export function defaultProviderTemplates(): readonly ProviderTemplate[] {
  return [
    chatProviderTemplate({
      templateId: "openai-gpt",
      kind: "openai",
      displayName: "OpenAI GPT",
      description: "Official OpenAI endpoint using the built-in OpenAI provider.",
      providerId: "openai",
      model: "gpt-5.5",
      api: "openai-completions",
      apiKeyRef: "env:OPENAI_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "anthropic-claude",
      kind: "anthropic",
      displayName: "Claude",
      description: "Official Anthropic Messages API endpoint.",
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      apiKeyRef: "env:ANTHROPIC_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "local-openai-compatible-relay",
      kind: "openai-compatible",
      displayName: "Local OpenAI-Compatible Relay",
      description: "Local relay, One API, New API, LiteLLM, OpenRouter-style gateways, or private compatible gateways.",
      providerId: "local-relay",
      model: "dpv4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "doubao-ark",
      kind: "doubao",
      displayName: "Doubao Ark",
      description: "Volcengine Ark OpenAI-compatible chat endpoint for Doubao models.",
      providerId: "doubao",
      model: "doubao-seed-1-6",
      api: "openai-completions",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:ARK_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "deepseek-dpv4",
      kind: "deepseek",
      displayName: "DeepSeek DPV4",
      description: "DeepSeek OpenAI-compatible endpoint; model can be changed to a DPV4-compatible relay model.",
      providerId: "deepseek",
      model: "deepseek-v3",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyRef: "env:DEEPSEEK_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "minimax-chat",
      kind: "minimax",
      displayName: "MiniMax",
      description: "MiniMax OpenAI-compatible chat endpoint.",
      providerId: "minimax",
      model: "MiniMax-M1",
      api: "openai-completions",
      baseUrl: "https://api.minimax.chat/v1",
      apiKeyRef: "env:MINIMAX_API_KEY",
    }),
    chatProviderTemplate({
      templateId: "glm-zhipu",
      kind: "glm",
      displayName: "GLM Zhipu",
      description: "Zhipu GLM OpenAI-compatible chat endpoint.",
      providerId: "glm",
      model: "glm-4.5",
      api: "openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyRef: "env:ZHIPU_API_KEY",
    }),
    mediaProviderTemplate({
      templateId: "jimeng-image",
      kind: "jimeng",
      displayName: "Jimeng Image",
      description: "Jimeng image generation/editing capability placeholder for the future media job runtime.",
      providerId: "jimeng",
      model: "jimeng-image",
      apiKeyRef: "env:JIMENG_API_KEY",
      capabilities: ["image_generate", "image_edit"],
    }),
    mediaProviderTemplate({
      templateId: "seedream-image",
      kind: "seedream",
      displayName: "Seedream Image",
      description: "Seedream image provider. image_generate can use live Ark HTTP when mediaVendorTransport.mode is explicitly set to live; image_edit remains deferred.",
      providerId: "seedream",
      model: "doubao-seedream-5-0-260128",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      capabilities: ["image_generate", "image_edit"],
    }),
    mediaProviderTemplate({
      templateId: "seedance-video",
      kind: "seedance",
      displayName: "Seedance Video",
      description: "Seedance video generation capability placeholder for the future media job runtime.",
      providerId: "seedance",
      model: "seedance",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      capabilities: ["video_generate"],
    }),
  ];
}

function chatProviderTemplate(input: {
  readonly templateId: string;
  readonly kind: ProviderPresetInput["kind"];
  readonly displayName: string;
  readonly description: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderPresetInput["api"];
  readonly baseUrl?: string;
  readonly apiKeyRef: string;
}): ProviderTemplate {
  return {
    ...input,
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    enabled: false,
    authHeader: true,
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function mediaProviderTemplate(input: {
  readonly templateId: string;
  readonly kind: ProviderPresetInput["kind"];
  readonly displayName: string;
  readonly description: string;
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKeyRef: string;
  readonly capabilities: ProviderPresetInput["capabilities"];
}): ProviderTemplate {
  return {
    kind: input.kind,
    templateId: input.templateId,
    displayName: input.displayName,
    description: input.description,
    providerId: input.providerId,
    model: input.model,
    baseUrl: input.baseUrl,
    api: "media-job",
    apiKeyRef: input.apiKeyRef,
    capabilities: input.capabilities,
    input: ["text", "image"],
    enabled: false,
  };
}
