import type { SQLOutputValue } from "node:sqlite";
import type { SkillSourceSnapshot } from "../../skill-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { skillSourceSnapshotSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { mapSkillSourceSnapshot } from "./task-skill-mappers.js";

export function rollbackSkillSourceSnapshot(
  { database }: SqliteStoreContext, snapshotId: string, now: string,
): SkillSourceSnapshot | undefined {
  // Acquire the writer before reading; readers must never see a half rollback.
  database.exec("BEGIN IMMEDIATE");
  try {
    const readTarget = () => {
      const row = database.prepare(skillSourceSnapshotSelectSql("WHERE workspace_id = ? AND id = ?"))
        .get(DEFAULT_WORKSPACE_ID, snapshotId);
      return row ? mapSkillSourceSnapshot(row as Record<string, SQLOutputValue>) : undefined;
    };
    const target = readTarget();
    if (target) {
      // An explicit rollback is a version choice, not permission to follow again.
      database.prepare(`UPDATE skill_source_snapshots SET bundle_update_mode = 'pinned'
        WHERE workspace_id = ? AND id = ? AND bundle_update_mode IS NOT NULL`)
        .run(DEFAULT_WORKSPACE_ID, target.id);
      database.prepare(`UPDATE skill_source_snapshots SET review_status = 'archived', updated_at = ?
        WHERE workspace_id = ? AND skill_id = ? AND review_status = 'published' AND id != ?`)
        .run(now, DEFAULT_WORKSPACE_ID, target.skillId, target.id);
      if (target.reviewStatus !== "published") {
        database.prepare(`UPDATE skill_source_snapshots SET review_status = 'published', updated_at = ?
          WHERE workspace_id = ? AND id = ?`).run(now, DEFAULT_WORKSPACE_ID, target.id);
      }
    }
    const result = target ? readTarget() : undefined;
    database.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
