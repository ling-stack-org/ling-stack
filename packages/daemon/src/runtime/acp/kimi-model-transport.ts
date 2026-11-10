import { openNativeModelRelay } from "../adapters/native-model-relay.js";
import { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";
import { createKimiOAuthCredentialSource, type KimiOAuthCredentialOptions } from "./kimi-oauth-credentials.js";

export type KimiModelAuthentication = Pick<KimiOAuthCredentialOptions, "store" | "profile" | "region" | "fetchImpl">;

const invalid = (): Error => new Error("kimi_model_transport_invalid");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);

/** Bind validated host configuration to one inference route without projecting account secrets. */
export async function openKimiModelTransport(configuration: Record<string, unknown>, options: {
  readonly modelId?: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly assertPreparationCurrent?: () => void;
  readonly authentication?: KimiModelAuthentication;
  readonly secretRegistry?: NativeSecretRegistry;
}) {
  configuration = structuredClone(configuration);
  options = { ...options, authentication: options.authentication ? { ...options.authentication,
    profile: structuredClone(options.authentication.profile) } : undefined };
  const modelId = options.modelId ?? configuration.default_model;
  if (!text(modelId) || !record(configuration.models) || !record(configuration.providers)
    || !Object.hasOwn(configuration.models, modelId)) throw invalid();
  const model = configuration.models[modelId];
  if (!record(model) || !text(model.model) || !text(model.provider)
    || !Object.hasOwn(configuration.providers, model.provider)) throw invalid();
  const provider = configuration.providers[model.provider];
  if (!record(provider) || !text(provider.type)) throw invalid();
  const oauth = provider.oauth;
  if (oauth === undefined ? !text(provider.api_key) : !options.authentication || !record(oauth)
    || oauth.storage !== "file" || !text(oauth.key) || (oauth.oauth_host !== undefined && !text(oauth.oauth_host))) {
    throw new Error("kimi_model_transport_auth_unsupported");
  }
  const protocol = model.protocol ?? provider.type;
  const endpoint = protocol === "openai" || protocol === "kimi" ? "chat/completions"
    : protocol === "openai_responses" ? "responses" : protocol === "anthropic" ? "messages" : undefined;
  if (!endpoint) throw new Error("kimi_model_transport_protocol_unsupported");
  const baseUrl = model.base_url ?? provider.base_url;
  if (!text(baseUrl)) throw invalid();
  // The native Anthropic catalog removes terminal /v1 before the SDK appends it.
  const base = new URL(protocol === "anthropic" ? baseUrl.replace(/\/v1\/?$/, "") : baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw invalid();
  const configuredHeaders = provider.custom_headers ?? {};
  if (!record(configuredHeaders) || Object.values(configuredHeaders).some(value => typeof value !== "string")) throw invalid();
  const headers: Record<string, string> = protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};
  if (oauth === undefined) Object.assign(headers, protocol === "anthropic"
    ? { "x-api-key": provider.api_key } : { authorization: `Bearer ${provider.api_key}` });
  if (oauth !== undefined && Object.keys(configuredHeaders).some(name => /^(authorization|x-api-key)$/i.test(name))) throw invalid();
  for (const [name, value] of Object.entries(configuredHeaders)) headers[name.toLowerCase()] = value as string;
  const secrets = [provider.api_key, ...Object.values(configuredHeaders)].filter((value): value is string => typeof value === "string" && value.length > 0);
  const registry = options.secretRegistry ?? new NativeSecretRegistry();
  registry.register(secrets);
  let resolveHeaders: ((signal: AbortSignal) => Promise<Record<string, string>>) | undefined;
  let prepareCredentials: (() => Promise<void>) | undefined;
  if (oauth !== undefined) {
    const auth = options.authentication!;
    let preparing = true;
    const credentials = createKimiOAuthCredentialSource({ ...auth, home: auth.store.getAuthProfileDirectory(auth.profile),
      oauth: oauth as KimiOAuthCredentialOptions["oauth"],
      assertCurrent: () => (preparing ? options.assertPreparationCurrent ?? options.assertCurrent : options.assertCurrent)(),
      onSecrets: values => registry.register(values) });
    prepareCredentials = async () => {
      await credentials.resolve(options.signal);
      preparing = false;
    };
    resolveHeaders = async (signal): Promise<Record<string, string>> => {
      const key = await credentials.resolve(signal);
      return protocol === "anthropic" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
    };
  }
  const anthropic = protocol === "anthropic";
  const nativeModelId = model.model;
  const upstreamPath = anthropic ? `/v1/${endpoint}` : `/${endpoint}`;
  const relay = await openNativeModelRelay({ routes: (anthropic ? ["", "?beta=true"] : [""]).map(query => ({
    path: `/v1/${endpoint}${query}`, upstreamUrl: `${base.href.replace(/\/$/, "")}${upstreamPath}${query}`,
    modelId: nativeModelId, headers, forwardAnthropicBeta: anthropic })),
    signal: options.signal, assertCurrent: options.assertCurrent, resolveHeaders });
  try {
    registry.register(Object.values(relay.headers));
    await prepareCredentials?.();
  }
  catch (error) { await relay.close(); throw error; }
  const projectedBase = `${relay.baseUrl}${anthropic ? "" : "/v1"}`;
  return { relay, secrets: registry.getSnapshot(), secretRegistry: registry,
    configuration: { ...configuration, default_model: modelId,
      models: { [modelId]: { ...structuredClone(model), ...(model.base_url !== undefined ? { base_url: projectedBase } : {}) } },
      providers: { [model.provider]: { type: provider.type, base_url: projectedBase,
        api_key: "ling-relay", custom_headers: relay.headers } } } };
}
