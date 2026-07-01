import {
  createProviderPresetId,
  providerTransports,
  type ListProviderPresetsOptions,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
  type ProviderTransport,
} from "../../provider-types.js";
import {
  booleanToSql,
  nullableUpdate,
  readString,
  stringifyJson,
} from "./helpers.js";
import { mapProviderPreset } from "./provider-mappers.js";
import { providerPresetSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteProviderStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset {
    const preset: ProviderPreset = {
      id: createProviderPresetId(),
      kind: input.kind,
      displayName: input.displayName,
      providerId: input.providerId,
      model: input.model,
      api: input.api,
      providerTransport: normalizeProviderTransport(input.providerTransport),
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
      headers: input.headers ?? {},
      secretHeaderRefs: input.secretHeaderRefs ?? {},
      authHeader: input.authHeader,
      reasoning: input.reasoning,
      thinkingModes: input.thinkingModes,
      input: input.input ?? ["text"],
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      compat: input.compat ?? {},
      capabilities: input.capabilities,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO provider_presets (
          id,
          kind,
          display_name,
          provider_id,
          model,
          api,
          provider_transport,
          base_url,
          api_key_ref,
          headers_json,
          secret_header_refs_json,
          auth_header,
          reasoning,
          thinking_modes_json,
          input_json,
          context_window,
          max_tokens,
          compat_json,
          capabilities_json,
          enabled,
          last_check_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preset.id,
        preset.kind,
        preset.displayName,
        preset.providerId,
        preset.model,
        preset.api,
        preset.providerTransport ?? null,
        preset.baseUrl ?? null,
        preset.apiKeyRef ?? null,
        stringifyJson(preset.headers),
        stringifyJson(preset.secretHeaderRefs),
        booleanToSql(preset.authHeader),
        booleanToSql(preset.reasoning),
        stringifyJson(preset.thinkingModes ?? []),
        stringifyJson(preset.input),
        preset.contextWindow ?? null,
        preset.maxTokens ?? null,
        stringifyJson(preset.compat),
        stringifyJson(preset.capabilities),
        preset.enabled ? 1 : 0,
        preset.lastCheck ? stringifyJson(preset.lastCheck) : null,
        preset.createdAt,
        preset.updatedAt,
      );

    const created = this.getProviderPreset(preset.id);
    if (!created) {
      throw new Error(`Failed to create provider preset: ${preset.id}`);
    }
    return created;
  }

  getProviderPreset(id: string): ProviderPreset | undefined {
    const row = this.context.database.prepare(providerPresetSelectSql("WHERE id = ?")).get(id);
    return row ? mapProviderPreset(row) : undefined;
  }

  listProviderPresets(options: ListProviderPresetsOptions = {}): ProviderPreset[] {
    const whereClause = options.enabled === undefined ? "" : "WHERE enabled = ?";
    const statement = this.context.database.prepare(`${providerPresetSelectSql(whereClause)} ORDER BY created_at DESC`);
    const rows = options.enabled === undefined ? statement.all() : statement.all(options.enabled ? 1 : 0);
    return rows.map(mapProviderPreset);
  }

  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined {
    const existing = this.getProviderPreset(id);
    if (!existing) {
      return undefined;
    }

    const next: ProviderPreset = {
      ...existing,
      kind: input.kind ?? existing.kind,
      displayName: input.displayName ?? existing.displayName,
      providerId: input.providerId ?? existing.providerId,
      model: input.model ?? existing.model,
      api: input.api ?? existing.api,
      providerTransport: normalizeProviderTransportUpdate(input.providerTransport, existing.providerTransport),
      baseUrl: nullableUpdate(input.baseUrl, existing.baseUrl),
      apiKeyRef: nullableUpdate(input.apiKeyRef, existing.apiKeyRef),
      headers: input.headers ?? existing.headers,
      secretHeaderRefs: input.secretHeaderRefs ?? existing.secretHeaderRefs,
      authHeader: nullableUpdate(input.authHeader, existing.authHeader),
      reasoning: nullableUpdate(input.reasoning, existing.reasoning),
      thinkingModes: input.thinkingModes ?? existing.thinkingModes,
      input: input.input ?? existing.input,
      contextWindow: nullableUpdate(input.contextWindow, existing.contextWindow),
      maxTokens: nullableUpdate(input.maxTokens, existing.maxTokens),
      compat: input.compat ?? existing.compat,
      capabilities: input.capabilities ?? existing.capabilities,
      enabled: input.enabled ?? existing.enabled,
      lastCheck: undefined,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE provider_presets
        SET
          kind = ?,
          display_name = ?,
          provider_id = ?,
          model = ?,
          api = ?,
          provider_transport = ?,
          base_url = ?,
          api_key_ref = ?,
          headers_json = ?,
          secret_header_refs_json = ?,
          auth_header = ?,
          reasoning = ?,
          thinking_modes_json = ?,
          input_json = ?,
          context_window = ?,
          max_tokens = ?,
          compat_json = ?,
          capabilities_json = ?,
          enabled = ?,
          last_check_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.kind,
        next.displayName,
        next.providerId,
        next.model,
        next.api,
        next.providerTransport ?? null,
        next.baseUrl ?? null,
        next.apiKeyRef ?? null,
        stringifyJson(next.headers),
        stringifyJson(next.secretHeaderRefs),
        booleanToSql(next.authHeader),
        booleanToSql(next.reasoning),
        stringifyJson(next.thinkingModes ?? []),
        stringifyJson(next.input),
        next.contextWindow ?? null,
        next.maxTokens ?? null,
        stringifyJson(next.compat),
        stringifyJson(next.capabilities),
        next.enabled ? 1 : 0,
        next.lastCheck ? stringifyJson(next.lastCheck) : null,
        next.updatedAt,
        id,
      );

    return this.getProviderPreset(id);
  }

  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined {
    const updateResult = this.context.database
      .prepare("UPDATE provider_presets SET last_check_json = ? WHERE id = ?")
      .run(stringifyJson(result), id);
    if (Number(updateResult.changes) === 0) {
      return undefined;
    }
    return this.getProviderPreset(id);
  }

  deleteProviderPreset(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM provider_presets WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setProviderSecret(providerId: string, secretValue: string, now: string): void {
    this.context.database
      .prepare(`
        INSERT INTO provider_secrets (
          provider_id,
          secret_value,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          secret_value = excluded.secret_value,
          updated_at = excluded.updated_at
      `)
      .run(providerId, secretValue, now, now);
  }

  getProviderSecret(providerId: string): string | undefined {
    const row = this.context.database
      .prepare("SELECT secret_value FROM provider_secrets WHERE provider_id = ?")
      .get(providerId);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasProviderSecret(providerId: string): boolean {
    return Boolean(this.context.database.prepare("SELECT 1 AS found FROM provider_secrets WHERE provider_id = ?").get(providerId));
  }

  deleteProviderSecret(providerId: string): boolean {
    const result = this.context.database.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(providerId);
    return Number(result.changes) > 0;
  }
}

function normalizeProviderTransport(value: ProviderTransport | null | undefined): ProviderTransport | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!providerTransports.includes(value)) {
    throw new Error(`providerTransport must be one of: ${providerTransports.join(", ")}`);
  }
  return value;
}

function normalizeProviderTransportUpdate(
  value: ProviderTransport | null | undefined,
  existing: ProviderTransport | undefined,
): ProviderTransport | undefined {
  if (value === undefined) {
    return existing;
  }
  return normalizeProviderTransport(value);
}
