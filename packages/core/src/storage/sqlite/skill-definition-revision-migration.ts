import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applySkillDefinitionRevisionMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(185)) return;
  context.database.exec("SAVEPOINT skill_definition_history_migration");
  try {
    context.database.exec(`
      CREATE TABLE IF NOT EXISTS skill_definition_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        base_revision_id TEXT,
        before_json TEXT,
        after_json TEXT NOT NULL CHECK (json_valid(after_json)),
        kind TEXT NOT NULL CHECK (kind IN ('baseline', 'create', 'edit', 'undo')),
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_job_id TEXT,
        source_candidate_id TEXT,
        validation_status TEXT NOT NULL DEFAULT 'not_run',
        undo_of_revision_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, skill_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_definition_history ON skill_definition_revisions(workspace_id, skill_id, revision DESC);
      CREATE TABLE IF NOT EXISTS skill_definition_revision_notices (
        revision_id TEXT PRIMARY KEY REFERENCES skill_definition_revisions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notified_at TEXT
      );
    `);
    // Capture only the currently known definition. No before-image exists for historical imports.
    context.database.prepare(`INSERT INTO skill_definition_revisions
      (id, workspace_id, skill_id, revision, after_json, kind, actor, reason, validation_status, created_at)
      SELECT 'skill_revision_' || lower(hex(randomblob(16))), workspace_id, id, 0, definition_json,
        'baseline', 'migration', 'Current definition captured when history was introduced', 'not_run', ?
      FROM skill_definitions WHERE NOT EXISTS (SELECT 1 FROM skill_definition_revisions WHERE skill_id = skill_definitions.id)`)
      .run(new Date().toISOString());
    context.database.exec(`
      CREATE TRIGGER IF NOT EXISTS skill_definition_history_create AFTER INSERT ON skill_definitions BEGIN
        INSERT INTO skill_definition_revisions
          (id, workspace_id, skill_id, revision, after_json, kind, actor, reason, created_at)
          VALUES ('skill_revision_' || lower(hex(randomblob(16))), new.workspace_id, new.id, 1,
            new.definition_json, 'create', 'source', 'Definition created by its owning source', new.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS skill_definition_history_update AFTER UPDATE OF definition_json ON skill_definitions
      WHEN old.definition_json IS NOT new.definition_json BEGIN
        INSERT INTO skill_definition_revisions
          (id, workspace_id, skill_id, revision, base_revision_id, before_json, after_json, kind, actor, reason, created_at)
          VALUES ('skill_revision_' || lower(hex(randomblob(16))), new.workspace_id, new.id,
            COALESCE((SELECT MAX(revision) FROM skill_definition_revisions WHERE skill_id = new.id), 0) + 1,
            (SELECT id FROM skill_definition_revisions WHERE skill_id = new.id ORDER BY revision DESC LIMIT 1),
            old.definition_json, new.definition_json, 'edit', 'source', 'Definition changed by its owning source', new.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS skill_definition_history_notice AFTER INSERT ON skill_definition_revisions
      WHEN new.kind != 'baseline' BEGIN
        INSERT INTO skill_definition_revision_notices(revision_id, workspace_id, skill_id, created_at)
          VALUES (new.id, new.workspace_id, new.skill_id, new.created_at);
      END;
    `);
    context.recordMigration(185, "immutable_skill_definition_revision_history");
    context.database.exec("RELEASE skill_definition_history_migration");
  } catch (error) {
    context.database.exec("ROLLBACK TO skill_definition_history_migration; RELEASE skill_definition_history_migration");
    throw error;
  }
}
