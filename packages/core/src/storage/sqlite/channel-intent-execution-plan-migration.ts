import type { DatabaseSync } from "node:sqlite";
import { isChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION = 113;
export const CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_NAME = "upgrade_channel_intent_execution_to_operation_plan";

export interface ChannelIntentExecutionPlanMigrationContext {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyChannelIntentExecutionPlanMigration(
  input: ChannelIntentExecutionPlanMigrationContext,
): boolean {
  const exists = input.database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_intent_decisions'")
    .get();
  if (!exists) {
    throw new Error("Channel Intent execution-plan migration requires table: channel_intent_decisions");
  }
  if (input.hasMigration(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION) && postconditionsPass(input.database)) {
    return false;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    const rows = input.database
      .prepare("SELECT id, execution_json FROM channel_intent_decisions WHERE execution_json IS NOT NULL")
      .all() as unknown as readonly { readonly id: string; readonly execution_json: string }[];
    const update = input.database.prepare("UPDATE channel_intent_decisions SET execution_json = ? WHERE id = ?");
    for (const row of rows) {
      const parsed = JSON.parse(row.execution_json) as unknown;
      if (!isJsonRecord(parsed)) {
        throw new Error(`Invalid Channel Intent execution JSON: ${row.id}`);
      }
      if (isChannelIntentExecutionPlanV1(parsed)) continue;
      if (Array.isArray(parsed.operations)) {
        throw new Error(`Invalid Channel Intent execution plan JSON: ${row.id}`);
      }
      const kind = parsed.kind;
      const targetKind = parsed.targetKind;
      if (typeof kind !== "string" || typeof targetKind !== "string") {
        throw new Error(`Invalid singular Channel Intent execution JSON: ${row.id}`);
      }
      const targetRef = parsed.targetRef ?? {
        type: "operation",
        id: `legacy:${row.id}:operation_1`,
        label: `Unresolved legacy ${targetKind} target`,
      };
      const targetLabel = isJsonRecord(targetRef) && typeof targetRef.label === "string"
        ? targetRef.label.trim()
        : "";
      if (kind === "run_command" && targetKind === "command" && !targetLabel) {
        throw new Error(`Legacy command operation has no exact command authority: ${row.id}`);
      }
      update.run(JSON.stringify({
        operations: [{
          id: "operation_1",
          kind,
          targetKind,
          targetRef,
          ...(kind === "run_command" && targetKind === "command"
            ? { commandMatchPolicy: { kind: "exact_command", command: targetLabel } }
            : {}),
          required: true,
          dependsOn: [],
        }],
      }), row.id);
    }
    assertPostconditions(input.database);
    if (!input.hasMigration(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION)) {
      input.recordMigration(CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_VERSION, CHANNEL_INTENT_EXECUTION_PLAN_MIGRATION_NAME);
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function postconditionsPass(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    return true;
  } catch {
    return false;
  }
}

function assertPostconditions(database: DatabaseSync): void {
  const rows = database.prepare(
    "SELECT id, execution_json FROM channel_intent_decisions WHERE execution_json IS NOT NULL",
  ).all() as unknown as readonly { readonly id: string; readonly execution_json: string }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.execution_json) as unknown;
    } catch (error) {
      throw new Error(`Invalid Channel Intent execution JSON: ${row.id}`, { cause: error });
    }
    if (!isChannelIntentExecutionPlanV1(parsed)) {
      throw new Error(`Channel Intent execution-plan migration postcondition failed: ${row.id}`);
    }
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
