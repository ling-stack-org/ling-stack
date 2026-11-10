import type { SQLOutputValue } from "node:sqlite";
import { SkillRevisionStoreError, type PublishSkillRevisionDraftInput, type SkillDefinitionRevision,
  type SkillDefinitionUndoRequest, type SkillRegistryEntry } from "../../skill-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { parseJson, readNullableString, readNumber, readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { AppendControlPlaneEventInput, ControlPlaneEvent } from "../../run-types.js";

/** Move notices into the replayable event stream atomically. Live delivery happens after commit. */
export function drainSkillDefinitionRevisionNotices(
  context: SqliteStoreContext, cwd: string, now: string,
  append: (input: AppendControlPlaneEventInput, now: string) => ControlPlaneEvent, limit = 100,
): ControlPlaneEvent[] {
  if (!Number.isFinite(limit)) throw new RangeError("Notice limit must be finite");
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    const pending = database.prepare(`SELECT r.* FROM skill_definition_revision_notices n
      JOIN skill_definition_revisions r ON r.id = n.revision_id
      WHERE n.notified_at IS NULL ORDER BY n.rowid LIMIT ?`)
      .all(Math.max(1, Math.min(1000, Math.trunc(limit))));
    const events = pending.map(row => {
      const revision = mapRevision(row);
      const event = append({ workspaceId: revision.workspaceId, cwd, domain: "skills", entityType: "registry",
        entityId: revision.skillId, action: "skill.registry_changed",
        idempotencyKey: `skill-definition-revision:${revision.id}`,
        data: { changeType: revision.kind === "undo" ? "definition_undo" : "revision",
          skillId: revision.skillId, revisionId: revision.id, validationStatus: revision.validationStatus },
      }, now);
      database.prepare("UPDATE skill_definition_revision_notices SET notified_at = ? WHERE revision_id = ?")
        .run(now, revision.id);
      return event;
    });
    database.exec("COMMIT");
    return events;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}

export function listSkillDefinitionRevisions(
  context: SqliteStoreContext, skillId: string, limit = 50,
): SkillDefinitionRevision[] {
  if (!Number.isFinite(limit)) throw new RangeError("History limit must be finite");
  return context.database.prepare(`SELECT * FROM skill_definition_revisions
    WHERE workspace_id = ? AND skill_id = ? ORDER BY revision DESC LIMIT ?`)
    .all(DEFAULT_WORKSPACE_ID, skillId, Math.min(100, Math.max(1, Math.trunc(limit))))
    .map(row => mapRevision(row));
}

export function getSkillDefinitionRevision(
  context: SqliteStoreContext, skillId: string, revisionId?: string,
): SkillDefinitionRevision | undefined {
  const row = context.database.prepare(`SELECT * FROM skill_definition_revisions
    WHERE workspace_id = ? AND skill_id = ?${revisionId ? " AND id = ?" : ""} ORDER BY revision DESC LIMIT 1`)
    .get(DEFAULT_WORKSPACE_ID, skillId, ...(revisionId ? [revisionId] : []));
  return row ? mapRevision(row) : undefined;
}

/** Complete metadata only for the new trigger-captured revision, inside the owning source transaction. */
export function completeNewSkillDefinitionRevision(context: SqliteStoreContext, input: PublishSkillRevisionDraftInput,
  previousRevisionId: string | undefined): SkillDefinitionRevision | undefined {
  const revision = getSkillDefinitionRevision(context, input.skillId);
  if (!revision || revision.id === previousRevisionId) return revision;
  context.database.prepare(`UPDATE skill_definition_revisions SET actor = ?, reason = ?, source_job_id = ?,
    source_candidate_id = ?, validation_status = ? WHERE id = ?`)
    .run(input.actor ?? "local-user", input.reason ?? "Skill definition edited", input.sourceJobId ?? null,
      input.sourceCandidateId ?? null, input.validationStatus ?? "not_run", revision.id);
  return getSkillDefinitionRevision(context, input.skillId, revision.id);
}

export function nextSkillDefinitionTimestamp(now: string, previous: string): string {
  const next = Date.parse(now), before = Date.parse(previous);
  if (!Number.isFinite(next) || !Number.isFinite(before)) throw new SkillRevisionStoreError("skill_revision_invalid", "Revision timestamp is invalid");
  return next > before ? now : new Date(before + 1).toISOString();
}

export function undoSkillDefinitionRevision(
  context: SqliteStoreContext,
  getSkill: (id: string) => SkillRegistryEntry | undefined,
  skillId: string,
  input: SkillDefinitionUndoRequest,
  now: string,
): { readonly skill: SkillRegistryEntry; readonly revision: SkillDefinitionRevision; readonly reused: boolean } {
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    const skill = getSkill(skillId);
    if (!skill || skill.reviewStatus === "archived" || !["custom", "skill-directory", "agents-md"].includes(skill.source)) {
      throw new SkillRevisionStoreError("skill_revision_invalid", "Skill is not editable");
    }
    const already = database.prepare(`SELECT * FROM skill_definition_revisions
      WHERE workspace_id = ? AND skill_id = ? AND undo_of_revision_id = ?`).get(DEFAULT_WORKSPACE_ID, skillId, input.revisionId);
    if (already) {
      database.exec("COMMIT");
      return { skill, revision: mapRevision(already), reused: true };
    }
    const target = database.prepare(`SELECT * FROM skill_definition_revisions
      WHERE workspace_id = ? AND skill_id = ? AND id = ?`).get(DEFAULT_WORKSPACE_ID, skillId, input.revisionId);
    if (!target || target.before_json === null || target.kind === "baseline" || target.kind === "create") {
      throw new SkillRevisionStoreError("skill_revision_invalid", "This revision has no restorable before-image; newly created skills use reviewed archival");
    }
    const head = getSkillDefinitionRevision(context, skillId);
    const current = database.prepare("SELECT definition_json FROM skill_definitions WHERE workspace_id = ? AND id = ?")
      .get(DEFAULT_WORKSPACE_ID, skillId);
    if (head?.id !== input.revisionId || current?.definition_json !== target.after_json || skill.updatedAt !== input.expectedUpdatedAt) {
      throw new SkillRevisionStoreError("skill_revision_conflict", "Skill changed after this revision; inspect the current differences before undoing");
    }
    const before = parseJson(String(target.before_json)) as SkillRegistryEntry["definition"];
    if (!input.confirmAuthorityChanges && authoritySignature(before) !== authoritySignature(skill.definition)) {
      throw new SkillRevisionStoreError("skill_revision_confirmation_required", "Undo changes skill authority and requires explicit confirmation");
    }
    const updatedAt = nextSkillDefinitionTimestamp(now, skill.updatedAt);
    database.prepare("UPDATE skill_definitions SET definition_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(target.before_json, updatedAt, DEFAULT_WORKSPACE_ID, skillId);
    const restored = getSkillDefinitionRevision(context, skillId)!;
    database.prepare(`UPDATE skill_definition_revisions SET kind = 'undo', actor = 'local-user', reason = ?,
      validation_status = 'not_run', undo_of_revision_id = ? WHERE id = ?`)
      .run(input.reason ?? `Undo revision ${input.revisionId}`, input.revisionId, restored.id);
    const result = { skill: getSkill(skillId)!, revision: getSkillDefinitionRevision(context, skillId, restored.id)!, reused: false };
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}

function authoritySignature(definition: SkillRegistryEntry["definition"]): string {
  return JSON.stringify({ tools: [...definition.requiredTools].sort(), providers: [...definition.requiredProviderCapabilities].sort(),
    approval: definition.approvalProfile });
}

function mapRevision(row: Record<string, SQLOutputValue>): SkillDefinitionRevision {
  return {
    id: readString(row, "id"), workspaceId: readString(row, "workspace_id"), skillId: readString(row, "skill_id"),
    revision: readNumber(row, "revision"), baseRevisionId: readNullableString(row, "base_revision_id"),
    beforeDefinition: row.before_json === null ? undefined : parseJson(readString(row, "before_json")) as SkillDefinitionRevision["afterDefinition"],
    afterDefinition: parseJson(readString(row, "after_json")) as SkillDefinitionRevision["afterDefinition"],
    kind: readString(row, "kind") as SkillDefinitionRevision["kind"], actor: readString(row, "actor"), reason: readString(row, "reason"),
    sourceJobId: readNullableString(row, "source_job_id"), sourceCandidateId: readNullableString(row, "source_candidate_id"),
    validationStatus: readString(row, "validation_status") as SkillDefinitionRevision["validationStatus"],
    undoOfRevisionId: readNullableString(row, "undo_of_revision_id"), createdAt: readString(row, "created_at"),
  };
}
