import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createSkillImportDraftId,
  createSkillPackId,
  type CreateSkillImportDraftInput,
  type ListSkillRegistryOptions,
  type SkillImportDraft,
  type SkillRegistryEntry,
  type SkillVisibility,
} from "../../skill-types.js";
import { omitUndefined, stringifyJson } from "./helpers.js";
import { mapSkillImportDraft, mapSkillRegistryEntry } from "./task-skill-mappers.js";
import { skillImportDraftSelectSql, skillRegistryEntrySelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteSkillRegistryStore {
  constructor(private readonly context: SqliteStoreContext) {}

  listSkillRegistryEntries(options: ListSkillRegistryOptions = {}): SkillRegistryEntry[] {
    const conditions = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (!options.includeArchived) {
      conditions.push("review_status != 'archived'");
    }
    if (!options.includeDisabled) {
      conditions.push("review_status != 'disabled'");
    }
    return this.context.database
      .prepare(`${skillRegistryEntrySelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY source ASC, id ASC`)
      .all(...params)
      .map(mapSkillRegistryEntry);
  }

  getSkillRegistryEntry(id: string): SkillRegistryEntry | undefined {
    const row = this.context.database
      .prepare(skillRegistryEntrySelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillRegistryEntry(row as Record<string, SQLOutputValue>) : undefined;
  }

  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft {
    const id = input.id ?? createSkillImportDraftId();
    const draft: SkillImportDraft = omitUndefined({
      id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: input.source,
      sourcePath: input.sourcePath,
      packId: input.packId,
      name: input.name,
      version: input.version,
      description: input.description,
      definitions: input.definitions,
      warnings: input.warnings ?? [],
      createdAt: now,
      updatedAt: now,
    });
    this.context.database
      .prepare(`
        INSERT INTO skill_import_drafts (
          id,
          workspace_id,
          source,
          source_path,
          draft_json,
          warnings_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        draft.id,
        DEFAULT_WORKSPACE_ID,
        draft.source,
        draft.sourcePath ?? null,
        stringifyJson({
          packId: draft.packId,
          name: draft.name,
          version: draft.version,
          description: draft.description,
          definitions: draft.definitions,
        }),
        stringifyJson(draft.warnings),
        now,
        now,
      );
    return draft;
  }

  getSkillImportDraft(id: string): SkillImportDraft | undefined {
    const row = this.context.database
      .prepare(skillImportDraftSelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillImportDraft(row as Record<string, SQLOutputValue>) : undefined;
  }

  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[] {
    const draft = this.getSkillImportDraft(id);
    if (!draft) {
      throw new Error(`Skill import draft not found: ${id}`);
    }
    const allWarnings = [
      ...draft.warnings,
      ...draft.definitions.flatMap((definition) => definition.warnings ?? []),
    ];
    if (allWarnings.some((warning) => warning.severity === "error")) {
      throw new Error("Skill import draft has error warnings and cannot be published");
    }
    const packId = draft.packId ?? createSkillPackId();
    this.context.database.exec("BEGIN");
    try {
      this.context.database
        .prepare(`
          INSERT INTO skill_packs (
            id,
            workspace_id,
            source,
            name,
            version,
            description,
            source_path,
            checksum,
            review_status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            name = excluded.name,
            version = excluded.version,
            description = excluded.description,
            source_path = excluded.source_path,
            checksum = excluded.checksum,
            review_status = excluded.review_status,
            updated_at = excluded.updated_at
        `)
        .run(
          packId,
          DEFAULT_WORKSPACE_ID,
          draft.source,
          draft.name,
          draft.version ?? null,
          draft.description,
          draft.sourcePath ?? null,
          null,
          "published",
          now,
          now,
        );
      const insertDefinition = this.context.database.prepare(`
        INSERT INTO skill_definitions (
          id,
          workspace_id,
          pack_id,
          source,
          source_path,
          version,
          checksum,
          definition_json,
          visibility_json,
          review_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          pack_id = excluded.pack_id,
          source = excluded.source,
          source_path = excluded.source_path,
          version = excluded.version,
          checksum = excluded.checksum,
          definition_json = excluded.definition_json,
          visibility_json = excluded.visibility_json,
          review_status = excluded.review_status,
          updated_at = excluded.updated_at
      `);
      for (const item of draft.definitions) {
        insertDefinition.run(
          item.definition.id,
          DEFAULT_WORKSPACE_ID,
          packId,
          draft.source,
          draft.sourcePath ?? null,
          draft.version ?? null,
          null,
          stringifyJson(item.definition),
          stringifyJson(item.visibility ?? defaultSkillVisibility()),
          "published",
          now,
          now,
        );
      }
      this.context.database
        .prepare("UPDATE skill_import_drafts SET updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, DEFAULT_WORKSPACE_ID, id);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return draft.definitions
      .map((item) => this.getSkillRegistryEntry(item.definition.id))
      .filter((entry): entry is SkillRegistryEntry => Boolean(entry));
  }

  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined {
    const existing = this.getSkillRegistryEntry(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare("UPDATE skill_definitions SET review_status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, DEFAULT_WORKSPACE_ID, id);
    return this.getSkillRegistryEntry(id);
  }
}

function defaultSkillVisibility(): SkillVisibility {
  return {
    workspaceVisible: true,
    promotableToWorkspace: true,
  };
}
