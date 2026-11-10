import { kimiProviderTypes } from "@ling-stack/contracts";

type RecordValue = Record<string, unknown>;
const invalid = (): Error => new Error("kimi_execution_configuration_invalid");
const modelFields = ["max_context_size", "max_input_size", "max_output_size", "capabilities", "display_name",
  "reasoning_key", "adaptive_thinking", "support_efforts", "default_effort", "off_effort"];

/** Accept native TOML model fields without projecting unrelated services or credential sources. */
export function normalizeKimiModelConfiguration(value: RecordValue): {
  readonly providers: RecordValue;
  readonly models: Record<string, RecordValue>;
} {
  if (!record(value.models) || !record(value.providers)) throw invalid();
  for (const [name, provider] of Object.entries(value.providers)) {
    if (!text(name) || !record(provider) || !keys(provider, ["type", "base_url", "api_key", "oauth", "custom_headers", "env", "default_model", "source"])
      || !kimiProviderTypes.some(type => type === provider.type)) throw invalid();
    validateAuth(provider);
    for (const key of ["base_url", "default_model"]) if (provider[key] !== undefined && typeof provider[key] !== "string") throw invalid();
    if (provider.source !== undefined && !record(provider.source)) throw invalid();
    if (provider.env !== undefined && !stringRecord(provider.env)) throw invalid();
  }
  const models: Record<string, RecordValue> = Object.create(null);
  for (const [name, model] of Object.entries(value.models)) {
    if (!text(name) || !record(model) || !keys(model, [...modelFields, "provider", "model", "protocol", "beta_api", "base_url", "overrides"])
      || !text(model.provider) || !Object.hasOwn(value.providers, model.provider) || !text(model.model)) throw invalid();
    validateModelFields(model, true);
    if (model.protocol !== undefined && !["anthropic", "openai_responses"].includes(String(model.protocol))) throw invalid();
    if (model.beta_api !== undefined && typeof model.beta_api !== "boolean") throw invalid();
    if (model.base_url !== undefined && !text(model.base_url)) throw invalid();
    const { overrides, ...base } = model;
    if (overrides !== undefined && (!record(overrides) || !keys(overrides, modelFields))) throw invalid();
    if (record(overrides)) validateModelFields(overrides, false);
    const effective = { ...base, ...(record(overrides) ? overrides : {}) };
    if (record(overrides) && Array.isArray(overrides.support_efforts) && overrides.default_effort === undefined
      && effective.default_effort !== undefined && !overrides.support_efforts.includes(effective.default_effort)) delete effective.default_effort;
    if (typeof effective.max_input_size === "number" && typeof effective.max_context_size === "number") {
      effective.max_input_size = Math.min(effective.max_input_size, effective.max_context_size);
    }
    models[name] = effective;
  }
  if (value.services !== undefined) {
    if (!record(value.services) || !keys(value.services, ["moonshot_search", "moonshot_fetch"])) throw invalid();
    for (const service of Object.values(value.services)) {
      if (!record(service) || !keys(service, ["base_url", "api_key", "oauth", "custom_headers"])
        || (service.base_url !== undefined && typeof service.base_url !== "string")) throw invalid();
      validateAuth(service);
    }
  }
  return { providers: value.providers, models };
}

function validateAuth(value: RecordValue): void {
  if (value.api_key !== undefined && typeof value.api_key !== "string") throw invalid();
  if (value.custom_headers !== undefined && !stringRecord(value.custom_headers)) throw invalid();
  if (value.oauth !== undefined && (text(value.api_key) || !record(value.oauth)
    || !keys(value.oauth, ["storage", "key", "oauth_host"]) || value.oauth.storage !== "file" || !text(value.oauth.key)
    || (value.oauth.oauth_host !== undefined && !text(value.oauth.oauth_host)))) throw invalid();
}

function validateModelFields(model: RecordValue, required: boolean): void {
  for (const key of ["max_context_size", "max_input_size", "max_output_size"]) {
    if (((required && key === "max_context_size") || model[key] !== undefined)
      && (typeof model[key] !== "number" || !Number.isSafeInteger(model[key]) || model[key] < 1)) throw invalid();
  }
  for (const key of ["display_name", "reasoning_key", "default_effort", "off_effort"]) {
    if (model[key] !== undefined && typeof model[key] !== "string") throw invalid();
  }
  for (const key of ["capabilities", "support_efforts"]) {
    if (model[key] !== undefined && (!Array.isArray(model[key]) || model[key].length > 256 || !model[key].every(text))) throw invalid();
  }
  if (model.adaptive_thinking !== undefined && typeof model.adaptive_thinking !== "boolean") throw invalid();
}
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value); }
function keys(value: RecordValue, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function stringRecord(value: unknown): boolean { return record(value) && Object.values(value).every(item => typeof item === "string"); }
