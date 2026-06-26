import type { SQLOutputValue } from "node:sqlite";
import type { ProviderCheckResult, ProviderPreset } from "../../provider-types.js";
import {
  omitUndefined,
  parseJsonObject,
  parseJsonStringArray,
  parseJsonStringRecord,
  readBoolean,
  readNullableBoolean,
  readNullableNumber,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapProviderPreset(row: Record<string, SQLOutputValue>): ProviderPreset {
  return omitUndefined({
    id: readString(row, "id"),
    kind: readString(row, "kind") as ProviderPreset["kind"],
    displayName: readString(row, "display_name"),
    providerId: readString(row, "provider_id"),
    model: readString(row, "model"),
    api: readString(row, "api") as ProviderPreset["api"],
    providerTransport: readNullableString(row, "provider_transport") as ProviderPreset["providerTransport"],
    baseUrl: readNullableString(row, "base_url"),
    apiKeyRef: readNullableString(row, "api_key_ref"),
    headers: parseJsonStringRecord(readString(row, "headers_json")),
	    authHeader: readNullableBoolean(row, "auth_header"),
	    reasoning: readNullableBoolean(row, "reasoning"),
	    thinkingModes: parseJsonStringArray(readString(row, "thinking_modes_json")) as ProviderPreset["thinkingModes"],
	    input: parseJsonStringArray(readString(row, "input_json")) as ProviderPreset["input"],
    contextWindow: readNullableNumber(row, "context_window"),
    maxTokens: readNullableNumber(row, "max_tokens"),
    compat: parseJsonObject(readString(row, "compat_json")),
    capabilities: parseJsonStringArray(readString(row, "capabilities_json")) as ProviderPreset["capabilities"],
    enabled: readBoolean(row, "enabled"),
    lastCheck: parseProviderCheckResult(readNullableString(row, "last_check_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseProviderCheckResult(value: string | undefined): ProviderCheckResult | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseJsonObject(value);
  if (typeof parsed.ok !== "boolean" || typeof parsed.message !== "string" || typeof parsed.checkedAt !== "string") {
    throw new Error("Expected provider check result from SQLite");
  }
  if (parsed.code !== undefined && typeof parsed.code !== "string") {
    throw new Error("Expected provider check code to be a string");
  }

  const code = typeof parsed.code === "string" ? parsed.code : undefined;
  return omitUndefined({
    ok: parsed.ok,
    code,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as ProviderCheckResult;
}
