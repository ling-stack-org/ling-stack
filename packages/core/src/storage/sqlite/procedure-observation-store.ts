import type { SQLOutputValue } from "node:sqlite";
import {
  createProcedureObservationClusterId,
  createProcedureObservationId,
  type CandidateRouteBlocker,
  type CandidateRouteKind,
  type CreateProcedureObservationInput,
  type ListProcedureObservationsOptions,
  type ProcedureObservation,
  type ProcedureObservationConfidence,
  type ProcedureObservationSignal,
  type ProcedureObservationSource,
  type ProcedureObservationStep,
  type ProcedureObservationValidationStep,
} from "../../procedure-observation-types.js";
import type { SkillCandidateSourceRef } from "../../skill-candidate-types.js";
import { routeProcedureObservation } from "../../candidate-router.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { parseJson, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const procedureObservationSelectSql = `
  SELECT
    id,
    workspace_id,
    cluster_id,
    channel_id,
    teammate_id,
    task_id,
    run_id,
    source,
    signals_json,
    title,
    summary,
    normalized_goal,
    positive_triggers_json,
    negative_triggers_json,
    procedure_steps_json,
    validation_steps_json,
    source_refs_json,
    confidence,
    reusable_score,
    route_kind,
    route_reason_code,
    route_blockers_json,
    created_at
  FROM procedure_observations
`;

export class SqliteProcedureObservationStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createProcedureObservation(input: CreateProcedureObservationInput, now: string): ProcedureObservation {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const baseObservation: ProcedureObservation = {
      id: input.id ?? createProcedureObservationId(),
      workspaceId,
      clusterId: input.clusterId ?? createProcedureObservationClusterId({
        workspaceId,
        routeHint: input.route?.kind,
        scopeHint: input.channelId ?? input.teammateId ?? "workspace",
        normalizedGoal: input.normalizedGoal,
        positiveTriggers: input.positiveTriggers ?? [],
        procedureSteps: input.procedureSteps ?? [],
      }),
      channelId: input.channelId,
      teammateId: input.teammateId,
      taskId: input.taskId,
      runId: input.runId,
      source: input.source,
      signals: input.signals,
      title: input.title,
      summary: input.summary,
      normalizedGoal: input.normalizedGoal,
      positiveTriggers: input.positiveTriggers ?? [],
      negativeTriggers: input.negativeTriggers ?? [],
      procedureSteps: input.procedureSteps ?? [],
      validationSteps: input.validationSteps ?? [],
      sourceRefs: input.sourceRefs,
      confidence: input.confidence ?? "medium",
      reusableScore: input.reusableScore ?? 0,
      routeKind: input.route?.kind,
      routeReasonCode: input.route?.reasonCode,
      routeBlockers: input.route?.blockers ?? [],
      createdAt: now,
    };
    const route = input.route ?? routeProcedureObservation(baseObservation);
    const observation: ProcedureObservation = {
      ...baseObservation,
      routeKind: route.kind,
      routeReasonCode: route.reasonCode,
      routeBlockers: route.blockers,
    };
    validateProcedureObservation(observation);
    this.context.database
      .prepare(`
        INSERT INTO procedure_observations (
          id,
          workspace_id,
          cluster_id,
          channel_id,
          teammate_id,
          task_id,
          run_id,
          source,
          signals_json,
          title,
          summary,
          normalized_goal,
          positive_triggers_json,
          negative_triggers_json,
          procedure_steps_json,
          validation_steps_json,
          source_refs_json,
          confidence,
          reusable_score,
          route_kind,
          route_reason_code,
          route_blockers_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        observation.id,
        observation.workspaceId,
        observation.clusterId,
        observation.channelId ?? null,
        observation.teammateId ?? null,
        observation.taskId ?? null,
        observation.runId ?? null,
        observation.source,
        stringifyJson(observation.signals),
        observation.title,
        observation.summary,
        observation.normalizedGoal,
        stringifyJson(observation.positiveTriggers),
        stringifyJson(observation.negativeTriggers),
        stringifyJson(observation.procedureSteps),
        stringifyJson(observation.validationSteps),
        stringifyJson(observation.sourceRefs),
        observation.confidence,
        observation.reusableScore,
        observation.routeKind ?? null,
        observation.routeReasonCode ?? null,
        stringifyJson(observation.routeBlockers),
        observation.createdAt,
      );
    return observation;
  }

  listProcedureObservations(options: ListProcedureObservationsOptions = {}): ProcedureObservation[] {
    const conditions = ["workspace_id = ?"];
    const params: Array<string | number> = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.clusterId) {
      conditions.push("cluster_id = ?");
      params.push(options.clusterId);
    }
    if (options.routeKind) {
      conditions.push("route_kind = ?");
      params.push(options.routeKind);
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database
      .prepare(`${procedureObservationSelectSql} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapProcedureObservation(row as Record<string, SQLOutputValue>));
  }
}

function mapProcedureObservation(row: Record<string, SQLOutputValue>): ProcedureObservation {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    clusterId: readString(row, "cluster_id"),
    channelId: readNullableString(row, "channel_id"),
    teammateId: readNullableString(row, "teammate_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    source: readString(row, "source") as ProcedureObservationSource,
    signals: parseStringArray(readString(row, "signals_json")) as readonly ProcedureObservationSignal[],
    title: readString(row, "title"),
    summary: readString(row, "summary"),
    normalizedGoal: readString(row, "normalized_goal"),
    positiveTriggers: parseStringArray(readString(row, "positive_triggers_json")),
    negativeTriggers: parseStringArray(readString(row, "negative_triggers_json")),
    procedureSteps: parseProcedureSteps(readString(row, "procedure_steps_json")),
    validationSteps: parseValidationSteps(readString(row, "validation_steps_json")),
    sourceRefs: parseSourceRefs(readString(row, "source_refs_json")),
    confidence: readString(row, "confidence") as ProcedureObservationConfidence,
    reusableScore: readNumber(row, "reusable_score"),
    routeKind: readNullableString(row, "route_kind") as CandidateRouteKind | undefined,
    routeReasonCode: readNullableString(row, "route_reason_code"),
    routeBlockers: parseStringArray(readString(row, "route_blockers_json")) as readonly CandidateRouteBlocker[],
    createdAt: readString(row, "created_at"),
  };
}

function parseProcedureSteps(value: string): readonly ProcedureObservationStep[] {
  return parseJsonArray(value).map((item) => {
    if (!isPlainRecord(item)) {
      throw new Error("Expected procedure observation step object");
    }
    return {
      title: readRecordString(item, "title"),
      ...(typeof item.instruction === "string" ? { instruction: item.instruction } : {}),
      ...(Array.isArray(item.requiredTools) ? { requiredTools: item.requiredTools.map(String) } : {}),
      ...(typeof item.expectedEvidence === "string" ? { expectedEvidence: item.expectedEvidence } : {}),
    };
  });
}

function parseValidationSteps(value: string): readonly ProcedureObservationValidationStep[] {
  return parseJsonArray(value).map((item) => {
    if (!isPlainRecord(item)) {
      throw new Error("Expected procedure observation validation step object");
    }
    return {
      title: readRecordString(item, "title"),
      ...(typeof item.commandOrCheck === "string" ? { commandOrCheck: item.commandOrCheck } : {}),
      ...(typeof item.expectedResult === "string" ? { expectedResult: item.expectedResult } : {}),
    };
  });
}

function parseSourceRefs(value: string): readonly SkillCandidateSourceRef[] {
  return parseJsonArray(value).map((item) => {
    if (!isPlainRecord(item)) {
      throw new Error("Expected procedure observation source ref object");
    }
    return {
      type: readRecordString(item, "type") as SkillCandidateSourceRef["type"],
      id: readRecordString(item, "id"),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    };
  });
}

function parseStringArray(value: string): readonly string[] {
  return parseJsonArray(value).map(String);
}

function parseJsonArray(value: string): readonly unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from SQLite");
  }
  return parsed;
}

function validateProcedureObservation(observation: ProcedureObservation): void {
  if (!observation.id || !observation.workspaceId || !observation.clusterId) {
    throw new Error("Procedure observation id, workspace id, and cluster id are required");
  }
  if (!observation.title.trim() || !observation.summary.trim() || !observation.normalizedGoal.trim()) {
    throw new Error("Procedure observation title, summary, and normalized goal are required");
  }
  if (observation.sourceRefs.length === 0) {
    throw new Error("Procedure observation requires at least one source ref");
  }
  if (observation.reusableScore < 0 || observation.reusableScore > 100) {
    throw new Error("Procedure observation reusable score must be between 0 and 100");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}
