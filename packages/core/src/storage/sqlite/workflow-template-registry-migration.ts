import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION = 212;
const name = "workflow_template_registry";
const definitions = [
  { type: "table", name, sql: `CREATE TABLE workflow_template_registry (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK(kind='workflow_template'),
    source TEXT NOT NULL CHECK(source IN ('builtin','gstack','workspace','skill-directory','agents-md','custom')),
    source_path TEXT CHECK(source_path IS NULL OR length(source_path) BETWEEN 1 AND 4096),
    visibility_json TEXT NOT NULL CHECK(json_valid(visibility_json) AND json_type(visibility_json)='object'
      AND COALESCE(json_type(visibility_json,'$.workspaceVisible') IN ('true','false'),0)
      AND COALESCE(json_type(visibility_json,'$.promotableToWorkspace') IN ('true','false'),0)),
    review_status TEXT NOT NULL CHECK(review_status IN ('builtin','draft','published','disabled','archived')),
    latest_version TEXT NOT NULL CHECK(length(latest_version) BETWEEN 1 AND 128),
    published_version TEXT,
    published_digest TEXT,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL CHECK(updated_at>=created_at),
    PRIMARY KEY(workspace_id,id),
    CHECK((published_version IS NULL)=(published_digest IS NULL)),
    CHECK(review_status NOT IN ('published','builtin') OR published_version IS NOT NULL),
    CHECK(review_status<>'builtin' OR source='builtin'),
    FOREIGN KEY(workspace_id,id,latest_version) REFERENCES workflow_template_versions(workspace_id,template_id,version)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(workspace_id,id,published_version,published_digest) REFERENCES workflow_template_versions(workspace_id,template_id,version,digest)
      DEFERRABLE INITIALLY DEFERRED
  )` },
  { type: "table", name: "workflow_template_versions", sql: `CREATE TABLE workflow_template_versions (
    workspace_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind='workflow_template'),
    version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 128),
    digest TEXT NOT NULL CHECK(length(digest)=68 AND substr(digest,1,4)='wt1_' AND substr(digest,5) NOT GLOB '*[^0-9a-f]*'),
    template_json TEXT NOT NULL CHECK(length(template_json)<=1048576 AND json_valid(template_json)
      AND json_type(template_json)='object' AND COALESCE(json_type(template_json,'$.schemaVersion')='integer'
        AND json_extract(template_json,'$.schemaVersion')=1 AND json_type(template_json,'$.id')='text'
        AND json_extract(template_json,'$.id')=template_id,0)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,template_id,version),
    UNIQUE(workspace_id,template_id,version,digest),
    FOREIGN KEY(workspace_id,template_id) REFERENCES workflow_template_registry(workspace_id,id)
  )` },
  { type: "trigger", name: "trg_workflow_template_registry_created_draft", sql: `CREATE TRIGGER trg_workflow_template_registry_created_draft
    BEFORE INSERT ON workflow_template_registry WHEN NEW.revision<>1 OR NEW.review_status<>'draft'
      OR NEW.published_version IS NOT NULL OR NEW.published_digest IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'workflow_template_registry.create_draft_required'); END` },
  { type: "trigger", name: "trg_workflow_template_registry_immutable", sql: `CREATE TRIGGER trg_workflow_template_registry_immutable
    BEFORE UPDATE ON workflow_template_registry WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id
      OR NEW.kind IS NOT OLD.kind OR NEW.source IS NOT OLD.source OR NEW.source_path IS NOT OLD.source_path
      OR NEW.visibility_json IS NOT OLD.visibility_json OR NEW.created_at IS NOT OLD.created_at
      OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      OR (NEW.latest_version IS NOT OLD.latest_version AND NOT (
        NEW.review_status=CASE WHEN OLD.review_status IN ('disabled','archived') THEN OLD.review_status ELSE 'draft' END
        AND NEW.published_version IS OLD.published_version AND NEW.published_digest IS OLD.published_digest))
      OR ((NEW.published_version IS NOT OLD.published_version OR NEW.published_digest IS NOT OLD.published_digest)
        AND NEW.review_status NOT IN ('published','builtin'))
    BEGIN SELECT RAISE(ABORT,'workflow_template_registry.identity_or_revision_changed'); END` },
  { type: "trigger", name: "trg_workflow_template_registry_retained", sql: `CREATE TRIGGER trg_workflow_template_registry_retained
    BEFORE DELETE ON workflow_template_registry BEGIN SELECT RAISE(ABORT,'workflow_template_registry.history_retained'); END` },
  { type: "trigger", name: "trg_workflow_template_versions_immutable", sql: `CREATE TRIGGER trg_workflow_template_versions_immutable
    BEFORE UPDATE ON workflow_template_versions BEGIN SELECT RAISE(ABORT,'workflow_template_registry.version_immutable'); END` },
  { type: "trigger", name: "trg_workflow_template_versions_retained", sql: `CREATE TRIGGER trg_workflow_template_versions_retained
    BEFORE DELETE ON workflow_template_versions BEGIN SELECT RAISE(ABORT,'workflow_template_registry.history_retained'); END` },
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
const tables = definitions.filter(definition => definition.type === "table").map(definition => definition.name);

export function applyWorkflowTemplateRegistryMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = (): boolean => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=211").get()?.name !== "workflow_isolation_selections")
      throw new Error("workflow_template_registry.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION))
      throw new Error("workflow_template_registry.migration_marker_conflict");
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_template_registry.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_template_registry.migration_schema_missing:${definition.name}`);
      if (!markers.length && actual && definition.type === "table"
        && input.database.prepare(`SELECT 1 FROM ${definition.name} LIMIT 1`).get())
        throw new Error("workflow_template_registry.migration_unmarked_data");
    }
    const known = new Set(definitions.map(definition => definition.name));
    for (const table of tables) {
      if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
        .all(table).some(row => !known.has(String(row.name)))) throw new Error("workflow_template_registry.migration_unexpected_object");
      if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
        throw new Error("workflow_template_registry.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_template_registry.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
