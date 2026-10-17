import { isDeepStrictEqual } from "node:util";
import { SkillSourcePublicationError, type CreateSkillSourceSnapshotInput,
  type PublishSkillSourceBatchInput, type PublishedSkillSourceBatch, type SkillSourceSnapshot } from "../../skill-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteSkillRegistryStore } from "./skill-registry-store.js";

function content(snapshot: CreateSkillSourceSnapshotInput) {
  return { skillId: snapshot.skillId, sourceKind: snapshot.sourceKind, sourcePath: snapshot.sourcePath,
    upstreamName: snapshot.upstreamName, upstreamVersion: snapshot.upstreamVersion,
    upstreamSkillPath: snapshot.upstreamSkillPath, sourceChecksum: snapshot.sourceChecksum,
    bundleUpdateMode: snapshot.bundleUpdateMode,
    rawSkillMarkdown: snapshot.rawSkillMarkdown, agentMetadata: snapshot.agentMetadata,
    referencedFiles: snapshot.referencedFiles ?? [], warnings: snapshot.warnings ?? [] };
}

export function publishSkillSourceBatch({ database }: SqliteStoreContext, store: SqliteSkillRegistryStore,
  input: PublishSkillSourceBatchInput, now: string): PublishedSkillSourceBatch {
  const invalid = (message: string): never => { throw new SkillSourcePublicationError("skill_source_publication_invalid", message); };
  const conflict = (skillId: string): never => {
    throw new SkillSourcePublicationError("skill_source_publication_conflict", `Skill source changed during preparation: ${skillId}`);
  };
  const ids = input.records.map(record => record.snapshot.skillId);
  if (new Set(ids).size !== ids.length) invalid("Duplicate skill source selection");
  database.exec("BEGIN IMMEDIATE");
  try {
    // Validate the entire batch under one writer lock before changing any active pointer.
    const unchanged = new Map<string, SkillSourceSnapshot>();
    for (const record of input.records) {
      const current = store.listSkillSourceSnapshots({ skillId: record.snapshot.skillId, reviewStatus: "published" });
      const active = current[0];
      if (record.requireBundledFollow && (active?.bundleUpdateMode !== "follow"
        || store.getSkillRegistryEntry(record.snapshot.skillId)?.reviewStatus === "archived"
        || store.getSkillRegistryEntry(record.snapshot.skillId)?.reviewStatus === "disabled"
        || store.listSkillSourceSnapshots({ skillId: record.snapshot.skillId, includeArchived: true })
          .some(snapshot => snapshot.reviewStatus === "draft" || snapshot.reviewStatus === "reviewed"))) {
        conflict(record.snapshot.skillId);
      }
      if (current.length === 1 && isDeepStrictEqual(content(active!), content(record.snapshot))) {
        unchanged.set(record.snapshot.skillId, active!);
        continue;
      }
      if (record.requireNoSourceHistory && store.listSkillSourceSnapshots({
        skillId: record.snapshot.skillId, includeArchived: true,
      }).length) conflict(record.snapshot.skillId);
      if (current.length > 1 || active?.id !== record.expectedSnapshotId ||
        active?.sourceChecksum !== record.expectedSourceChecksum) conflict(record.snapshot.skillId);
      if (record.snapshot.id && store.getSkillSourceSnapshotById(record.snapshot.id)) {
        invalid("Publication must not overwrite snapshot history");
      }
      for (const artifact of record.artifacts ?? []) {
        if (!record.snapshot.id || artifact.snapshotId !== record.snapshot.id ||
          artifact.id && store.getSkillSourceArtifact(artifact.id)) invalid("Artifact does not belong to a fresh snapshot");
      }
    }
    if (input.newSkills) {
      const definitions = input.newSkills.definitions.filter(item => !unchanged.has(item.definition.id));
      if (definitions.some(item => !ids.includes(item.definition.id) || store.getSkillRegistryEntry(item.definition.id))) {
        conflict("new skill identity");
      }
      if (definitions.length) {
        const draft = store.createSkillImportDraft({ ...input.newSkills, definitions }, now);
        store.publishSkillImportDraft(draft.id, now);
      }
    }
    const snapshots: SkillSourceSnapshot[] = [];
    const artifacts: PublishedSkillSourceBatch["artifacts"][number][] = [];
    for (const record of input.records) {
      const existing = unchanged.get(record.snapshot.skillId);
      if (existing) {
        snapshots.push(existing);
        artifacts.push(...store.listSkillSourceArtifacts({ snapshotId: existing.id }));
        continue;
      }
      database.prepare(`UPDATE skill_source_snapshots SET review_status = 'archived', updated_at = ?
        WHERE workspace_id = ? AND skill_id = ? AND review_status = 'published'`)
        .run(now, DEFAULT_WORKSPACE_ID, record.snapshot.skillId);
      snapshots.push(store.upsertSkillSourceSnapshot({ ...record.snapshot, reviewStatus: "published" }, now));
      for (const artifact of record.artifacts ?? []) artifacts.push(store.upsertSkillSourceArtifact(artifact, now));
    }
    database.exec("COMMIT");
    return { snapshots, artifacts };
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
