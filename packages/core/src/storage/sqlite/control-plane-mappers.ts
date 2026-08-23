import type { SQLOutputValue } from "node:sqlite";
import { type ControlPlaneDomain, type ControlPlaneEvent } from "../../run-types.js";
import { omitUndefined, parseJsonObject, readNullableString, readNumber, readString } from "./helpers.js";

export function mapControlPlaneEvent(row: Record<string, SQLOutputValue>): ControlPlaneEvent {
  return omitUndefined({
    seq: readNumber(row, "seq"),
    workspaceId: readString(row, "workspace_id"),
    cwd: readString(row, "cwd"),
    ts: readString(row, "ts"),
    domain: readString(row, "domain") as ControlPlaneDomain,
    entityType: readString(row, "entity_type"),
    entityId: readString(row, "entity_id"),
    action: readString(row, "action"),
    data: parseJsonObject(readString(row, "data_json")),
    idempotencyKey: readNullableString(row, "idempotency_key"),
  });
}
