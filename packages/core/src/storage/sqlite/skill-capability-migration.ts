import type { DatabaseSync } from "node:sqlite";
import { stringifyJson } from "./helpers.js";

export interface SkillCapabilityMigrationContext {
  readonly database: DatabaseSync;
  hasTable(tableName: string): boolean;
}

export function removeLegacySkillWorkflowPhaseMetadata(context: SkillCapabilityMigrationContext): void {
  if (context.hasTable("skill_definitions")) {
    rewriteJsonColumn(
      context.database,
      "SELECT id, definition_json AS json_value FROM skill_definitions",
      "UPDATE skill_definitions SET definition_json = ? WHERE id = ?",
      stripDefinitionWorkflowPhase,
    );
  }
  if (context.hasTable("skill_import_drafts")) {
    rewriteJsonColumn(
      context.database,
      "SELECT id, draft_json AS json_value FROM skill_import_drafts",
      "UPDATE skill_import_drafts SET draft_json = ? WHERE id = ?",
      stripImportDraftWorkflowPhases,
    );
  }
  if (context.hasTable("skill_candidates")) {
    rewriteJsonColumn(
      context.database,
      "SELECT id, definition_json AS json_value FROM skill_candidates",
      "UPDATE skill_candidates SET definition_json = ? WHERE id = ?",
      stripCandidateWorkflowPhases,
    );
  }
}

function rewriteJsonColumn(
  database: DatabaseSync,
  selectSql: string,
  updateSql: string,
  transform: (value: unknown) => unknown,
): void {
  const rows = database.prepare(selectSql).all() as { readonly id: string; readonly json_value: string }[];
  const update = database.prepare(updateSql);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.json_value);
    } catch {
      continue;
    }
    const next = transform(parsed);
    if (stringifyJson(next) !== stringifyJson(parsed)) {
      update.run(stringifyJson(next), row.id);
    }
  }
}

function stripDefinitionWorkflowPhase(value: unknown): unknown {
  if (!isJsonRecord(value)) {
    return value;
  }
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value;
  return definition;
}

function stripImportDraftWorkflowPhases(value: unknown): unknown {
  if (!isJsonRecord(value) || !Array.isArray(value.definitions)) {
    return value;
  }
  return {
    ...value,
    definitions: value.definitions.map((item) => {
      if (!isJsonRecord(item) || !isJsonRecord(item.definition)) {
        return item;
      }
      return { ...item, definition: stripDefinitionWorkflowPhase(item.definition) };
    }),
  };
}

function stripCandidateWorkflowPhases(value: unknown): unknown {
  if (!isJsonRecord(value)) {
    return value;
  }
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value;
  return isJsonRecord(definition.skillDefinition)
    ? { ...definition, skillDefinition: stripDefinitionWorkflowPhase(definition.skillDefinition) }
    : definition;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
