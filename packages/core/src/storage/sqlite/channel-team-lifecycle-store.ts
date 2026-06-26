import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
} from "../../workspace-types.js";
import {
  createChannelTeamIncidentId,
  type AvailabilityIncident,
  type ChannelTeamEvidenceSourceRef,
  type ChannelTeamIncidentSeverity,
  type CreateAvailabilityIncidentInput,
  type CreateReliabilityIncidentInput,
  type ListAvailabilityIncidentsOptions,
  type ListReliabilityIncidentsOptions,
  type ModelSignature,
  type ReliabilityIncident,
} from "../../channel-team-types.js";
import {
  parseChannelTeamEvidenceSourceRefs,
} from "./channel-team-evidence-mappers.js";
import {
  parseJsonObject,
  readBoolean,
  readNullableString,
  readString,
  stringifyJson,
} from "./helpers.js";
import { channelTeamIncidentSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteChannelTeamLifecycleStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createReliabilityIncident(input: CreateReliabilityIncidentInput, now: string): ReliabilityIncident {
    validateReliabilityIncident(input);
    const incident: ReliabilityIncident = {
      id: input.id ?? createChannelTeamIncidentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      agentId: input.agentId,
      capabilityScope: input.capabilityScope,
      kind: input.kind,
      severity: input.severity ?? "medium",
      summary: input.summary,
      sourceRefs: input.sourceRefs ?? [],
      modelSignature: input.modelSignature,
      recoveryRequired: input.recoveryRequired ?? false,
      recoveredAt: input.recoveredAt ?? undefined,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? undefined,
    };
    this.insertIncident({
      id: incident.id,
      incidentType: "reliability",
      agentId: incident.agentId,
      capabilityScope: incident.capabilityScope,
      providerPresetId: undefined,
      kind: incident.kind,
      severity: incident.severity,
      availabilityState: undefined,
      modelSignature: incident.modelSignature,
      summary: incident.summary,
      sourceRefs: incident.sourceRefs,
      recoveryRequired: incident.recoveryRequired ?? false,
      recoveredAt: incident.recoveredAt,
      observedAt: incident.createdAt,
      expiresAt: incident.expiresAt,
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt ?? incident.createdAt,
    });
    return incident;
  }

  createAvailabilityIncident(input: CreateAvailabilityIncidentInput, now: string): AvailabilityIncident {
    validateAvailabilityIncident(input);
    const observedAt = input.observedAt ?? now;
    const incident: AvailabilityIncident = {
      id: input.id ?? createChannelTeamIncidentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      agentId: input.agentId,
      providerPresetId: input.providerPresetId,
      modelSignature: input.modelSignature,
      state: input.state,
      kind: input.kind,
      severity: input.severity ?? "medium",
      summary: input.summary,
      observedAt,
      updatedAt: now,
      expiresAt: input.expiresAt ?? undefined,
    };
    this.insertIncident({
      id: incident.id,
      incidentType: "availability",
      agentId: incident.agentId,
      capabilityScope: undefined,
      providerPresetId: incident.providerPresetId,
      kind: incident.kind,
      severity: incident.severity,
      availabilityState: incident.state,
      modelSignature: incident.modelSignature,
      summary: incident.summary,
      sourceRefs: [],
      recoveryRequired: false,
      recoveredAt: undefined,
      observedAt: incident.observedAt,
      expiresAt: incident.expiresAt,
      createdAt: now,
      updatedAt: incident.updatedAt ?? now,
    });
    return incident;
  }

  listReliabilityIncidents(options: ListReliabilityIncidentsOptions = {}): ReliabilityIncident[] {
    const { clauses, params } = buildIncidentListQuery("reliability", options.now, options.includeExpired);
    if (options.agentId) {
      clauses.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.capabilityScope) {
      clauses.push("capability_scope = ?");
      params.push(options.capabilityScope);
    }
    params.push(clampLimit(options.limit));
    return this.context.database
      .prepare(`${channelTeamIncidentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY observed_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapReliabilityIncident(row as Record<string, SQLOutputValue>));
  }

  listAvailabilityIncidents(options: ListAvailabilityIncidentsOptions = {}): AvailabilityIncident[] {
    const { clauses, params } = buildIncidentListQuery("availability", options.now, options.includeExpired);
    if (options.agentId) {
      clauses.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    params.push(clampLimit(options.limit));
    return this.context.database
      .prepare(`${channelTeamIncidentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY observed_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapAvailabilityIncident(row as Record<string, SQLOutputValue>));
  }

  private insertIncident(input: {
    readonly id: string;
    readonly incidentType: "reliability" | "availability";
    readonly agentId?: string;
    readonly capabilityScope?: string;
    readonly providerPresetId?: string;
    readonly kind: string;
    readonly severity?: ChannelTeamIncidentSeverity;
    readonly availabilityState?: string;
    readonly modelSignature?: ModelSignature;
    readonly summary: string;
    readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
    readonly recoveryRequired: boolean;
    readonly recoveredAt?: string;
    readonly observedAt: string;
    readonly expiresAt?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }): void {
    this.context.database
      .prepare(`
        INSERT INTO channel_team_incidents (
          id,
          workspace_id,
          incident_type,
          agent_id,
          capability_scope,
          provider_preset_id,
          kind,
          severity,
          availability_state,
          model_signature_json,
          summary,
          source_refs_json,
          recovery_required,
          recovered_at,
          observed_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        DEFAULT_WORKSPACE_ID,
        input.incidentType,
        input.agentId ?? null,
        input.capabilityScope ?? null,
        input.providerPresetId ?? null,
        input.kind,
        input.severity ?? null,
        input.availabilityState ?? null,
        stringifyJson(input.modelSignature ?? {}),
        input.summary,
        stringifyJson(input.sourceRefs),
        input.recoveryRequired ? 1 : 0,
        input.recoveredAt ?? null,
        input.observedAt,
        input.expiresAt ?? null,
        input.createdAt,
        input.updatedAt,
      );
  }
}

function mapReliabilityIncident(row: Record<string, SQLOutputValue>): ReliabilityIncident {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    agentId: readString(row, "agent_id"),
    capabilityScope: readString(row, "capability_scope"),
    kind: readString(row, "kind") as ReliabilityIncident["kind"],
    severity: readNullableString(row, "severity") as ChannelTeamIncidentSeverity | undefined,
    summary: readString(row, "summary"),
    sourceRefs: parseChannelTeamEvidenceSourceRefs(readString(row, "source_refs_json")),
    modelSignature: readModelSignature(row),
    recoveryRequired: readBoolean(row, "recovery_required"),
    recoveredAt: readNullableString(row, "recovered_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    expiresAt: readNullableString(row, "expires_at"),
  };
}

function mapAvailabilityIncident(row: Record<string, SQLOutputValue>): AvailabilityIncident {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    agentId: readNullableString(row, "agent_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    modelSignature: readModelSignature(row),
    state: readString(row, "availability_state") as AvailabilityIncident["state"],
    kind: readString(row, "kind") as AvailabilityIncident["kind"],
    severity: readNullableString(row, "severity") as ChannelTeamIncidentSeverity | undefined,
    summary: readString(row, "summary"),
    observedAt: readString(row, "observed_at"),
    updatedAt: readString(row, "updated_at"),
    expiresAt: readNullableString(row, "expires_at"),
  };
}

function readModelSignature(row: Record<string, SQLOutputValue>): ModelSignature | undefined {
  const parsed = parseJsonObject(readString(row, "model_signature_json"));
  return Object.keys(parsed).length > 0 ? parsed as unknown as ModelSignature : undefined;
}

function buildIncidentListQuery(
  incidentType: "reliability" | "availability",
  now: string | undefined,
  includeExpired: boolean | undefined,
): { readonly clauses: string[]; readonly params: (string | number)[] } {
  const clauses = ["workspace_id = ?", "incident_type = ?"];
  const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, incidentType];
  if (includeExpired !== true && now) {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(now);
  }
  return { clauses, params };
}

function validateReliabilityIncident(input: CreateReliabilityIncidentInput): void {
  if (input.agentId.trim().length === 0) {
    throw new Error("reliability incident agentId is required");
  }
  if (input.capabilityScope.trim().length === 0) {
    throw new Error("reliability incident capabilityScope is required");
  }
  validateSummary(input.summary);
}

function validateAvailabilityIncident(input: CreateAvailabilityIncidentInput): void {
  if (!input.agentId && !input.providerPresetId && !input.modelSignature) {
    throw new Error("availability incident requires agentId, providerPresetId, or modelSignature");
  }
  validateSummary(input.summary);
}

function validateSummary(summary: string): void {
  if (summary.trim().length === 0) {
    throw new Error("channel team incident summary is required");
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}
