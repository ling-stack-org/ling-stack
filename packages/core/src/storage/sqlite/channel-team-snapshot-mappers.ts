import type { SQLOutputValue } from "node:sqlite";
import {
  channelTeamSnapshotCreatedByValues,
  type ChannelTeamEvaluationCase,
  type ChannelTeamEvaluationCaseResult,
  type ChannelTeamEvaluationRun,
  type ChannelTeamEvaluationSummary,
  type ChannelTeamSnapshot,
  type ChannelTeamSnapshotCreatedBy,
  type ChannelTeamSnapshotState,
} from "../../channel-team-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapChannelTeamSnapshot(row: Record<string, SQLOutputValue>): ChannelTeamSnapshot {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    reason: readString(row, "reason"),
    createdBy: readChannelTeamSnapshotCreatedBy(row, "created_by"),
    state: parseJsonObject(readString(row, "state_json")) as unknown as ChannelTeamSnapshotState,
    createdAt: readString(row, "created_at"),
  };
}

export function mapChannelTeamEvaluationRun(row: Record<string, SQLOutputValue>): ChannelTeamEvaluationRun {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    snapshotId: readNullableString(row, "snapshot_id"),
    cases: parseJson(readString(row, "cases_json")) as readonly ChannelTeamEvaluationCase[],
    results: parseJson(readString(row, "results_json")) as readonly ChannelTeamEvaluationCaseResult[],
    summary: parseJsonObject(readString(row, "summary_json")) as unknown as ChannelTeamEvaluationSummary,
    createdAt: readString(row, "created_at"),
  });
}

function readChannelTeamSnapshotCreatedBy(row: Record<string, SQLOutputValue>, key: string): ChannelTeamSnapshotCreatedBy {
  const value = readString(row, key);
  if (!channelTeamSnapshotCreatedByValues.includes(value as ChannelTeamSnapshotCreatedBy)) {
    throw new Error(`Expected SQLite column ${key} to be a channel team snapshot creator`);
  }
  return value as ChannelTeamSnapshotCreatedBy;
}
