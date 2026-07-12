import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createSkillImportDraftId,
  type CreateSkillCompiledRuntimeViewInput,
  createSkillSourceArtifactId,
  createSkillSourceSnapshotId,
  createSkillPackId,
  type CreateSkillImportDraftInput,
  type CreateSkillSourceArtifactInput,
  type CreateSkillSourceSnapshotInput,
  type ListSkillSourceArtifactOptions,
  type ListSkillCompiledRuntimeViewOptions,
  type ListSkillRegistryOptions,
  type ListSkillSourceSnapshotOptions,
  type SkillImportDraft,
  type SkillHardDeleteBlocker,
  type SkillHardDeleteResult,
  type SkillCompiledRuntimeViewRecord,
  type SkillDefinition,
  type SkillRegistryEntry,
  type SkillSourceArtifact,
  type SkillSourceSnapshot,
  type SkillSourceUpgradePolicy,
  type SkillVisibility,
  type UpdateSkillSourceUpgradePolicyInput,
  isManuallyImportedSkillSource,
} from "../../skill-types.js";
import { omitUndefined, stringifyJson } from "./helpers.js";
import { mapSkillCompiledRuntimeView, mapSkillImportDraft, mapSkillRegistryEntry, mapSkillSourceArtifact, mapSkillSourceSnapshot, mapSkillSourceUpgradePolicy } from "./task-skill-mappers.js";
import { skillCompiledRuntimeViewSelectSql, skillImportDraftSelectSql, skillRegistryEntrySelectSql, skillSourceArtifactSelectSql, skillSourceSnapshotSelectSql, skillSourceUpgradePolicySelectSql } from "./select-sql.js";
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

  listSkillSourceSnapshots(options: ListSkillSourceSnapshotOptions = {}): SkillSourceSnapshot[] {
    const conditions = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (options.skillId) {
      conditions.push("skill_id = ?");
      params.push(options.skillId);
    }
    if (options.sourceKind) {
      conditions.push("source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.reviewStatus) {
      conditions.push("review_status = ?");
      params.push(options.reviewStatus);
    } else if (!options.includeArchived) {
      conditions.push("review_status != 'archived'");
    }
    return this.context.database
      .prepare(`${skillSourceSnapshotSelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY updated_at DESC, id ASC`)
      .all(...params)
      .map((row) => mapSkillSourceSnapshot(row as Record<string, SQLOutputValue>));
  }

  getSkillSourceSnapshot(skillId: string, options: Pick<ListSkillSourceSnapshotOptions, "reviewStatus" | "includeArchived"> = {}): SkillSourceSnapshot | undefined {
    return this.listSkillSourceSnapshots({ ...options, skillId, reviewStatus: options.reviewStatus ?? "published" })[0];
  }

  getSkillSourceSnapshotById(id: string): SkillSourceSnapshot | undefined {
    const row = this.context.database
      .prepare(skillSourceSnapshotSelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillSourceSnapshot(row as Record<string, SQLOutputValue>) : undefined;
  }

  upsertSkillSourceSnapshot(input: CreateSkillSourceSnapshotInput, now: string): SkillSourceSnapshot {
    const id = input.id ?? createSkillSourceSnapshotId();
    const existing = this.getSkillSourceSnapshotById(id);
    const snapshot: SkillSourceSnapshot = omitUndefined({
      id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      skillId: input.skillId,
      sourceKind: input.sourceKind,
      sourcePath: input.sourcePath,
      upstreamName: input.upstreamName,
      upstreamVersion: input.upstreamVersion,
      upstreamSkillPath: input.upstreamSkillPath,
      sourceChecksum: input.sourceChecksum,
      rawSkillMarkdown: input.rawSkillMarkdown,
      rawSkillMarkdownArtifactId: input.rawSkillMarkdownArtifactId,
      agentMetadata: input.agentMetadata,
      referencedFiles: input.referencedFiles ?? [],
      warnings: input.warnings ?? [],
      reviewStatus: input.reviewStatus ?? "draft",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.context.database
      .prepare(`
        INSERT INTO skill_source_snapshots (
          id,
          workspace_id,
          skill_id,
          source_kind,
          source_path,
          upstream_name,
          upstream_version,
          upstream_skill_path,
          source_checksum,
          raw_skill_markdown,
          raw_skill_markdown_artifact_id,
          agent_metadata_json,
          referenced_files_json,
          warnings_json,
          review_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          skill_id = excluded.skill_id,
          source_kind = excluded.source_kind,
          source_path = excluded.source_path,
          upstream_name = excluded.upstream_name,
          upstream_version = excluded.upstream_version,
          upstream_skill_path = excluded.upstream_skill_path,
          source_checksum = excluded.source_checksum,
          raw_skill_markdown = excluded.raw_skill_markdown,
          raw_skill_markdown_artifact_id = excluded.raw_skill_markdown_artifact_id,
          agent_metadata_json = excluded.agent_metadata_json,
          referenced_files_json = excluded.referenced_files_json,
          warnings_json = excluded.warnings_json,
          review_status = excluded.review_status,
          updated_at = excluded.updated_at
      `)
      .run(
        snapshot.id,
        DEFAULT_WORKSPACE_ID,
        snapshot.skillId,
        snapshot.sourceKind,
        snapshot.sourcePath ?? null,
        snapshot.upstreamName ?? null,
        snapshot.upstreamVersion ?? null,
        snapshot.upstreamSkillPath ?? null,
        snapshot.sourceChecksum,
        snapshot.rawSkillMarkdown,
        snapshot.rawSkillMarkdownArtifactId ?? null,
        stringifyJson(snapshot.agentMetadata ?? null),
        stringifyJson(snapshot.referencedFiles),
        stringifyJson(snapshot.warnings),
        snapshot.reviewStatus,
        snapshot.createdAt,
        snapshot.updatedAt,
      );
    return this.getSkillSourceSnapshotById(snapshot.id) ?? snapshot;
  }

  archiveSkillSourceSnapshot(skillId: string, now: string): SkillSourceSnapshot | undefined {
    const existing = this.getSkillSourceSnapshot(skillId, { includeArchived: true });
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare("UPDATE skill_source_snapshots SET review_status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, DEFAULT_WORKSPACE_ID, existing.id);
    return this.getSkillSourceSnapshotById(existing.id);
  }

  rollbackSkillSourceSnapshot(snapshotId: string, now: string): SkillSourceSnapshot | undefined {
    const existing = this.getSkillSourceSnapshotById(snapshotId);
    if (!existing) {
      return undefined;
    }
    const current = this.getSkillSourceSnapshot(existing.skillId);
    if (current && current.id !== existing.id) {
      this.context.database
        .prepare("UPDATE skill_source_snapshots SET review_status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, DEFAULT_WORKSPACE_ID, current.id);
    }
    return this.upsertSkillSourceSnapshot({
      id: existing.id,
      skillId: existing.skillId,
      sourceKind: existing.sourceKind,
      sourcePath: existing.sourcePath,
      upstreamName: existing.upstreamName,
      upstreamVersion: existing.upstreamVersion,
      upstreamSkillPath: existing.upstreamSkillPath,
      sourceChecksum: existing.sourceChecksum,
      rawSkillMarkdown: existing.rawSkillMarkdown,
      rawSkillMarkdownArtifactId: existing.rawSkillMarkdownArtifactId,
      agentMetadata: existing.agentMetadata,
      referencedFiles: existing.referencedFiles,
      warnings: existing.warnings,
      reviewStatus: "published",
    }, now);
  }

  getSkillSourceUpgradePolicy(now = new Date().toISOString()): SkillSourceUpgradePolicy {
    const row = this.context.database
      .prepare(skillSourceUpgradePolicySelectSql("WHERE workspace_id = ?"))
      .get(DEFAULT_WORKSPACE_ID);
    if (row) {
      return mapSkillSourceUpgradePolicy(row as Record<string, SQLOutputValue>);
    }
    return this.updateSkillSourceUpgradePolicy({}, now);
  }

  updateSkillSourceUpgradePolicy(input: UpdateSkillSourceUpgradePolicyInput, now: string): SkillSourceUpgradePolicy {
    const existingRow = this.context.database
      .prepare(skillSourceUpgradePolicySelectSql("WHERE workspace_id = ?"))
      .get(DEFAULT_WORKSPACE_ID);
    const existing = existingRow ? mapSkillSourceUpgradePolicy(existingRow as Record<string, SQLOutputValue>) : undefined;
    const policy: SkillSourceUpgradePolicy = omitUndefined({
      workspaceId: DEFAULT_WORKSPACE_ID,
      mode: input.mode ?? existing?.mode ?? "prompt",
      approvedRootIds: input.approvedRootIds ?? existing?.approvedRootIds ?? [],
      allowNewSkills: input.allowNewSkills ?? existing?.allowNewSkills ?? false,
      allowGlobalGstackUpgrade: false as const,
      lastCheckedAt: input.lastCheckedAt ?? existing?.lastCheckedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.context.database
      .prepare(`
        INSERT INTO skill_source_upgrade_policies (
          workspace_id,
          mode,
          approved_root_ids_json,
          allow_new_skills,
          allow_global_gstack_upgrade,
          last_checked_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          mode = excluded.mode,
          approved_root_ids_json = excluded.approved_root_ids_json,
          allow_new_skills = excluded.allow_new_skills,
          allow_global_gstack_upgrade = excluded.allow_global_gstack_upgrade,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at
      `)
      .run(
        policy.workspaceId,
        policy.mode,
        stringifyJson(policy.approvedRootIds),
        policy.allowNewSkills ? 1 : 0,
        0,
        policy.lastCheckedAt ?? null,
        policy.createdAt,
        policy.updatedAt,
      );
    return mapSkillSourceUpgradePolicy(
      this.context.database
        .prepare(skillSourceUpgradePolicySelectSql("WHERE workspace_id = ?"))
        .get(DEFAULT_WORKSPACE_ID) as Record<string, SQLOutputValue>,
    );
  }

  upsertSkillSourceArtifact(input: CreateSkillSourceArtifactInput, now: string): SkillSourceArtifact {
    const id = input.id ?? createSkillSourceArtifactId();
    const existing = this.getSkillSourceArtifact(id);
    const artifact: SkillSourceArtifact = omitUndefined({
      id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      snapshotId: input.snapshotId,
      path: input.path,
      kind: input.kind,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      storageRef: input.storageRef,
      mediaType: input.mediaType,
      reviewStatus: input.reviewStatus ?? "draft",
      includedInRuntime: input.includedInRuntime ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.context.database
      .prepare(`
        INSERT INTO skill_source_artifacts (
          id,
          workspace_id,
          snapshot_id,
          path,
          kind,
          checksum,
          size_bytes,
          storage_ref,
          media_type,
          review_status,
          included_in_runtime,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          path = excluded.path,
          kind = excluded.kind,
          checksum = excluded.checksum,
          size_bytes = excluded.size_bytes,
          storage_ref = excluded.storage_ref,
          media_type = excluded.media_type,
          review_status = excluded.review_status,
          included_in_runtime = excluded.included_in_runtime,
          updated_at = excluded.updated_at
      `)
      .run(
        artifact.id,
        artifact.workspaceId,
        artifact.snapshotId,
        artifact.path,
        artifact.kind,
        artifact.checksum,
        artifact.sizeBytes,
        artifact.storageRef,
        artifact.mediaType ?? null,
        artifact.reviewStatus,
        artifact.includedInRuntime ? 1 : 0,
        artifact.createdAt,
        artifact.updatedAt,
      );
    return this.getSkillSourceArtifact(id) ?? artifact;
  }

  getSkillSourceArtifact(id: string): SkillSourceArtifact | undefined {
    const row = this.context.database
      .prepare(skillSourceArtifactSelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillSourceArtifact(row as Record<string, SQLOutputValue>) : undefined;
  }

  listSkillSourceArtifacts(options: ListSkillSourceArtifactOptions = {}): SkillSourceArtifact[] {
    const conditions = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (options.snapshotId) {
      conditions.push("snapshot_id = ?");
      params.push(options.snapshotId);
    }
    if (options.reviewStatus) {
      conditions.push("review_status = ?");
      params.push(options.reviewStatus);
    } else if (!options.includeArchived) {
      conditions.push("review_status != 'archived'");
    }
    return this.context.database
      .prepare(`${skillSourceArtifactSelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY updated_at DESC, id ASC`)
      .all(...params)
      .map((row) => mapSkillSourceArtifact(row as Record<string, SQLOutputValue>));
  }

  upsertSkillCompiledRuntimeView(input: CreateSkillCompiledRuntimeViewInput, now: string): SkillCompiledRuntimeViewRecord {
    const existing = this.getSkillCompiledRuntimeView(input.view.id);
    const record: SkillCompiledRuntimeViewRecord = {
      ...input.view,
      workspaceId: DEFAULT_WORKSPACE_ID,
      authorityBoundary: input.authorityBoundary,
      reviewStatus: input.reviewStatus ?? "active",
      createdAt: existing?.createdAt ?? input.view.createdAt,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO skill_compiled_runtime_views (
          id,
          workspace_id,
          skill_id,
          source_snapshot_id,
          compiler_version,
          core_rules_markdown,
          lazy_references_json,
          source_map_json,
          token_estimate,
          fallback_policy,
          authority_boundary_json,
          review_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          skill_id = excluded.skill_id,
          source_snapshot_id = excluded.source_snapshot_id,
          compiler_version = excluded.compiler_version,
          core_rules_markdown = excluded.core_rules_markdown,
          lazy_references_json = excluded.lazy_references_json,
          source_map_json = excluded.source_map_json,
          token_estimate = excluded.token_estimate,
          fallback_policy = excluded.fallback_policy,
          authority_boundary_json = excluded.authority_boundary_json,
          review_status = excluded.review_status,
          updated_at = excluded.updated_at
      `)
      .run(
        record.id,
        record.workspaceId,
        record.skillId,
        record.sourceSnapshotId,
        record.compilerVersion,
        record.coreRulesMarkdown,
        stringifyJson(record.lazyReferences),
        stringifyJson(record.sourceMap),
        record.tokenEstimate,
        record.fallbackPolicy,
        stringifyJson(record.authorityBoundary),
        record.reviewStatus,
        record.createdAt,
        record.updatedAt,
      );
    return this.getSkillCompiledRuntimeView(record.id) ?? record;
  }

  getSkillCompiledRuntimeView(id: string): SkillCompiledRuntimeViewRecord | undefined {
    const row = this.context.database
      .prepare(skillCompiledRuntimeViewSelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillCompiledRuntimeView(row as Record<string, SQLOutputValue>) : undefined;
  }

  listSkillCompiledRuntimeViews(options: ListSkillCompiledRuntimeViewOptions = {}): SkillCompiledRuntimeViewRecord[] {
    const conditions = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (options.skillId) {
      conditions.push("skill_id = ?");
      params.push(options.skillId);
    }
    if (options.sourceSnapshotId) {
      conditions.push("source_snapshot_id = ?");
      params.push(options.sourceSnapshotId);
    }
    if (options.reviewStatus) {
      conditions.push("review_status = ?");
      params.push(options.reviewStatus);
    } else if (!options.includeArchived) {
      conditions.push("review_status != 'archived'");
    }
    return this.context.database
      .prepare(`${skillCompiledRuntimeViewSelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY updated_at DESC, id ASC`)
      .all(...params)
      .map((row) => mapSkillCompiledRuntimeView(row as Record<string, SQLOutputValue>));
  }

  archiveSkillCompiledRuntimeView(id: string, now: string): SkillCompiledRuntimeViewRecord | undefined {
    const existing = this.getSkillCompiledRuntimeView(id);
    if (!existing) {
      return undefined;
    }
    this.context.database
      .prepare("UPDATE skill_compiled_runtime_views SET review_status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, DEFAULT_WORKSPACE_ID, id);
    return this.getSkillCompiledRuntimeView(id);
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
      definitions: input.definitions.map((item) => ({
        ...item,
        definition: withoutLegacySkillWorkflowPhase(item.definition),
      })),
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

  hardDeleteSkillRegistryEntry(id: string): SkillHardDeleteResult {
    const existing = this.getSkillRegistryEntry(id);
    if (!existing) {
      return { status: "not_found" };
    }
    if (!isManuallyImportedSkillSource(existing.source)) {
      return { status: "not_imported", skill: existing };
    }

    const blockers = this.listHardDeleteBlockers(id);
    if (blockers.length > 0) {
      return { status: "blocked", skill: existing, blockers };
    }

    const artifactStorageRefs = this.listArtifactStorageRefs(id);
    this.context.database.exec("BEGIN");
    try {
      this.context.database
        .prepare("DELETE FROM skill_source_snapshots WHERE workspace_id = ? AND skill_id = ?")
        .run(DEFAULT_WORKSPACE_ID, id);
      this.context.database
        .prepare("DELETE FROM skill_definitions WHERE workspace_id = ? AND id = ?")
        .run(DEFAULT_WORKSPACE_ID, id);
      this.context.database
        .prepare(`
          DELETE FROM skill_packs
          WHERE workspace_id = ?
            AND id = ?
            AND NOT EXISTS (
              SELECT 1 FROM skill_definitions
              WHERE skill_definitions.workspace_id = skill_packs.workspace_id
                AND skill_definitions.pack_id = skill_packs.id
            )
        `)
        .run(DEFAULT_WORKSPACE_ID, existing.packId);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return { status: "deleted", skill: existing, artifactStorageRefs };
  }

  private listHardDeleteBlockers(skillId: string): SkillHardDeleteBlocker[] {
    const database = this.context.database;
    return [
      ...deleteBlockersFromRows(
        "teammate_binding",
        database.prepare("SELECT teammate_id AS id FROM teammate_skill_bindings WHERE skill_id = ?").all(skillId),
      ),
      ...deleteBlockersFromRows(
        "active_task",
        database.prepare(`
          SELECT id FROM tasks
          WHERE workspace_id = ?
            AND requested_skill_id = ?
            AND status NOT IN ('done', 'failed', 'cancelled')
        `).all(DEFAULT_WORKSPACE_ID, skillId),
      ),
      ...deleteBlockersFromRows(
        "active_run",
        database.prepare(`
          SELECT id FROM run_sessions
          WHERE selected_skill_id = ?
            AND status NOT IN ('succeeded', 'failed', 'cancelled')
        `).all(skillId),
      ),
      ...deleteBlockersFromRows(
        "automation",
        database.prepare(`
          SELECT id FROM automation_definitions
          WHERE workspace_id = ?
            AND json_extract(execution_policy_json, '$.requestedSkillId') = ?
        `).all(DEFAULT_WORKSPACE_ID, skillId),
      ),
    ];
  }

  private listArtifactStorageRefs(skillId: string): string[] {
    const rows = this.context.database.prepare(`
      SELECT artifacts.storage_ref AS storage_ref
      FROM skill_source_artifacts AS artifacts
      INNER JOIN skill_source_snapshots AS snapshots ON snapshots.id = artifacts.snapshot_id
      WHERE snapshots.workspace_id = ? AND snapshots.skill_id = ?
    `).all(DEFAULT_WORKSPACE_ID, skillId) as Record<string, SQLOutputValue>[];
    return rows.flatMap((row) => typeof row.storage_ref === "string" ? [row.storage_ref] : []);
  }
}

function deleteBlockersFromRows(
  kind: SkillHardDeleteBlocker["kind"],
  rows: unknown,
): SkillHardDeleteBlocker[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return [];
    }
    const id = (row as Record<string, unknown>).id;
    return typeof id === "string" ? [{ kind, id }] : [];
  });
}

function defaultSkillVisibility(): SkillVisibility {
  return {
    workspaceVisible: true,
    promotableToWorkspace: true,
  };
}

function withoutLegacySkillWorkflowPhase(definition: SkillDefinition): SkillDefinition {
  const { workflowPhase: _legacyWorkflowPhase, ...currentDefinition } = definition as SkillDefinition & { readonly workflowPhase?: unknown };
  return currentDefinition;
}
