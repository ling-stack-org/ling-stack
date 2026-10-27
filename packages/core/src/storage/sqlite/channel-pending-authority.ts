import type { DatabaseSync } from "node:sqlite";
import type { ChannelPendingAuthorityVersions, GetChannelPendingAuthorityVersionsInput } from "../../channel-pending-operation.js";

export const CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION = 192;
const migrationName = "add_channel_pending_authority_versions";
const table = "channel_pending_authority_versions";
type Scope = "workspace" | "channel" | "participant";
type SchemaObject = { readonly name: string; readonly type: "table" | "trigger"; readonly sql: string };
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");
const changed = (columns: readonly string[]) => columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
const advance = (scope: Scope, owner: string) => `UPDATE ${table} SET revision=revision+1 WHERE scope='${scope}' AND owner_id=${owner};`;
const insert = (scope: Scope, owner: string, where = "") => `INSERT INTO ${table}(scope,owner_id,revision)
  SELECT '${scope}',${owner},0 ${where} ON CONFLICT(scope,owner_id) DO UPDATE SET revision=revision+1;`;

function ownerTriggers(scope: Scope, ownerTable: string, columns: readonly string[]): SchemaObject[] {
  return [
    { name: `pending_authority_${scope}_insert`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${scope}_insert
      AFTER INSERT ON ${ownerTable} BEGIN ${insert(scope, "NEW.id")} END` },
    { name: `pending_authority_${scope}_update`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${scope}_update
      AFTER UPDATE OF ${columns.join(",")} ON ${ownerTable} WHEN ${changed(columns)} BEGIN
      ${advance(scope, "OLD.id")} ${insert(scope, "NEW.id", "WHERE NEW.id IS NOT OLD.id")} END` },
    { name: `pending_authority_${scope}_delete`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${scope}_delete
      AFTER DELETE ON ${ownerTable} BEGIN ${advance(scope, "OLD.id")} END` },
  ];
}

function dependentTriggers(ownerTable: string, scope: Scope, ownerColumn: string, columns: readonly string[]): SchemaObject[] {
  return [
    { name: `pending_authority_${ownerTable}_insert`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${ownerTable}_insert
      AFTER INSERT ON ${ownerTable} BEGIN ${advance(scope, `NEW.${ownerColumn}`)} END` },
    { name: `pending_authority_${ownerTable}_update`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${ownerTable}_update
      AFTER UPDATE OF ${columns.join(",")} ON ${ownerTable} WHEN ${changed(columns)} BEGIN
      ${advance(scope, `OLD.${ownerColumn}`)}
      UPDATE ${table} SET revision=revision+1 WHERE scope='${scope}' AND owner_id=NEW.${ownerColumn} AND NEW.${ownerColumn} IS NOT OLD.${ownerColumn}; END` },
    { name: `pending_authority_${ownerTable}_delete`, type: "trigger", sql: `CREATE TRIGGER pending_authority_${ownerTable}_delete
      AFTER DELETE ON ${ownerTable} BEGIN ${advance(scope, `OLD.${ownerColumn}`)} END` },
  ];
}

/** Mirror the four effective permission fields read by SqliteWorkspaceSettingsStore. */
function permissionSelection(json: string): string {
  const object = `(CASE WHEN json_valid(${json}) THEN CASE WHEN json_type(${json})='object' THEN ${json} ELSE '{}' END ELSE '{}' END)`;
  const field = (name: string) => `json_extract(${object},'$.${name}')`;
  const mode = `(CASE WHEN ${field("defaultPermissionMode")} IN ('ask_everything','balanced','workspace_write','full_access','custom') THEN ${field("defaultPermissionMode")} ELSE 'workspace_write' END)`;
  const preset = `(CASE WHEN ${field("defaultPermissionPreset")} IN ('read_only','workspace_collaboration','full_access','custom') THEN ${field("defaultPermissionPreset")} ELSE 'workspace_collaboration' END)`;
  const legacy = (full: string, read: string, fallback: string) => `CASE WHEN ${mode}='full_access' AND ${preset}='full_access' THEN '${full}'
    WHEN ${mode}='ask_everything' AND ${preset}='read_only' THEN '${read}' ELSE '${fallback}' END`;
  const authorization = `CASE WHEN ${field("defaultAuthorizationMode")} IN ('ask','smart','always') THEN ${field("defaultAuthorizationMode")} ELSE ${legacy("always", "ask", "smart")} END`;
  const access = `CASE WHEN ${field("defaultWorkspaceAccessMode")} IN ('read_only','workspace_write','full_access') THEN ${field("defaultWorkspaceAccessMode")} ELSE ${legacy("full_access", "read_only", "workspace_write")} END`;
  return `json_array(${authorization},${access},${mode},${preset})`;
}

function councilChannels(ids: readonly string[]): string {
  return `UPDATE ${table} SET revision=revision+1 WHERE scope='channel' AND owner_id IN (
    SELECT policy.channel_id FROM channel_council_policies AS policy WHERE ${ids.map(id =>
    `(policy.preferred_council_id=${id} OR EXISTS(SELECT 1 FROM json_each(policy.attached_council_ids_json) WHERE value=${id}))`).join(" OR ")});`;
}
function councilTriggers(ownerTable: string, idColumn: string, columns: readonly string[]): SchemaObject[] {
  return ["insert", "update", "delete"].map(operation => ({
    name: `pending_authority_${ownerTable}_${operation}`, type: "trigger" as const,
    sql: `CREATE TRIGGER pending_authority_${ownerTable}_${operation} AFTER ${operation === "update" ? `UPDATE OF ${columns.join(",")}` : operation.toUpperCase()}
      ON ${ownerTable} ${operation === "update" ? `WHEN ${changed(columns)}` : ""} BEGIN
      ${councilChannels(operation === "insert" ? [`NEW.${idColumn}`] : operation === "delete" ? [`OLD.${idColumn}`] : [`OLD.${idColumn}`, `NEW.${idColumn}`])} END`,
  }));
}

const defaultPermissions = permissionSelection("'{}'");
const schema: readonly SchemaObject[] = [
  { name: table, type: "table", sql: `CREATE TABLE ${table} (
    scope TEXT NOT NULL CHECK(scope IN ('workspace','channel','participant')),
    owner_id TEXT NOT NULL CHECK(length(trim(owner_id))>0),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(scope,owner_id)
  )` },
  ...ownerTriggers("workspace", "workspaces", ["id", "default_provider_preset_id"]),
  ...ownerTriggers("channel", "channels", ["id", "workspace_id", "status", "bound_path", "workspace_binding_json", "default_provider_preset_id",
    "default_teammate_id", "allowed_tools_json", "runtime_policy_json", "auto_reply_mode", "response_language"]),
  ...ownerTriggers("participant", "ai_teammates", ["id", "workspace_id", "template_id", "role_key", "provider_preset_id", "runner_id",
    "model_binding_mode", "system_prompt", "append_system_prompt_json", "allowed_tools_json", "approval_profile_json", "status", "hidden"]),
  ...dependentTriggers("approval_policies", "workspace", "workspace_id", ["workspace_id", "tool_decisions_json", "allowed_write_paths_json"]),
  ...dependentTriggers("teammate_channel_memberships", "channel", "channel_id", ["teammate_id", "channel_id", "is_default"]),
  ...dependentTriggers("channel_collaboration_protocols", "channel", "channel_id", ["workspace_id", "channel_id", "version", "default_workflow_preference",
    "visible_multi_reply_max_participants", "privacy_rules_json", "review_rules_json", "source_refs_json", "updated_by"]),
  ...dependentTriggers("channel_council_policies", "channel", "channel_id", ["workspace_id", "channel_id", "attached_council_ids_json", "preferred_council_id"]),
  ...councilTriggers("ai_councils", "id", ["id", "workspace_id", "source", "template_id", "display_name", "description", "routing_policy_json", "governance_profile_json", "status", "pinned"]),
  ...councilTriggers("ai_council_members", "council_id", ["council_id", "teammate_id", "slot_key", "label", "position", "enabled"]),
  { name: "pending_authority_settings_insert", type: "trigger", sql: `CREATE TRIGGER pending_authority_settings_insert AFTER INSERT ON workspace_settings
    WHEN ${permissionSelection("NEW.settings_json")} IS NOT ${defaultPermissions} BEGIN ${advance("workspace", "NEW.workspace_id")} END` },
  { name: "pending_authority_settings_update", type: "trigger", sql: `CREATE TRIGGER pending_authority_settings_update AFTER UPDATE OF workspace_id,settings_json ON workspace_settings
    WHEN OLD.workspace_id IS NOT NEW.workspace_id OR ${permissionSelection("OLD.settings_json")} IS NOT ${permissionSelection("NEW.settings_json")} BEGIN
    ${advance("workspace", "OLD.workspace_id")}
    UPDATE ${table} SET revision=revision+1 WHERE scope='workspace' AND owner_id=NEW.workspace_id AND OLD.workspace_id IS NOT NEW.workspace_id; END` },
  { name: "pending_authority_settings_delete", type: "trigger", sql: `CREATE TRIGGER pending_authority_settings_delete AFTER DELETE ON workspace_settings
    WHEN ${permissionSelection("OLD.settings_json")} IS NOT ${defaultPermissions} BEGIN ${advance("workspace", "OLD.workspace_id")} END` },
];

/** Missing/drifted objects are never reconstructed from mutable current values. */
function inspect(database: DatabaseSync): boolean {
  const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
    .all(CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION, migrationName);
  if (markers.length > 1 || markers.some(row => row.version !== CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION || row.name !== migrationName)) {
    throw new Error("channel_pending_authority.marker_conflict");
  }
  const objects = database.prepare(`SELECT name,type,sql FROM sqlite_master WHERE name IN (${schema.map(() => "?").join(",")})`)
    .all(...schema.map(object => object.name));
  if (markers.length ? objects.length !== schema.length || schema.some(expected => {
    const actual = objects.find(object => object.name === expected.name);
    return !actual || actual.type !== expected.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(expected.sql);
  }) : objects.length > 0) throw new Error("channel_pending_authority.schema_conflict");
  return markers.length === 1;
}

export function applyChannelPendingAuthorityMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  if (inspect(database)) {
    if (!input.hasMigration(CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION)) throw new Error("channel_pending_authority.marker_conflict");
    return;
  }
  if (input.hasMigration(CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION)) throw new Error("channel_pending_authority.marker_conflict");
  database.exec("SAVEPOINT channel_pending_authority_migration");
  try {
    for (const object of schema) database.exec(object.sql);
    database.exec(`INSERT INTO ${table}(scope,owner_id,revision) SELECT 'workspace',id,0 FROM workspaces;
      INSERT INTO ${table}(scope,owner_id,revision) SELECT 'channel',id,0 FROM channels;
      INSERT INTO ${table}(scope,owner_id,revision) SELECT 'participant',id,0 FROM ai_teammates;`);
    input.recordMigration(CHANNEL_PENDING_AUTHORITY_MIGRATION_VERSION, migrationName);
    if (!inspect(database)) throw new Error("channel_pending_authority.migration_postcondition");
    database.exec("RELEASE channel_pending_authority_migration");
  } catch (error) {
    database.exec("ROLLBACK TO channel_pending_authority_migration");
    database.exec("RELEASE channel_pending_authority_migration");
    throw error;
  }
}

/** One statement reads the exact owner closure; callers cannot fall back to timestamps. */
export function getChannelPendingAuthorityVersions(database: DatabaseSync, input: GetChannelPendingAuthorityVersionsInput): ChannelPendingAuthorityVersions {
  if (!input || !text(input.workspaceId) || !text(input.channelId) || !Array.isArray(input.participantIds)
    || input.participantIds.length === 0 || input.participantIds.length > 500 || !input.participantIds.every(text)) {
    throw new Error("channel_pending_authority.scope_invalid");
  }
  if (!inspect(database)) throw new Error("channel_pending_authority.unavailable");
  const participantIds = [...new Set(input.participantIds)].sort();
  const owners = [{ scope: "workspace", id: input.workspaceId }, { scope: "channel", id: input.channelId },
    ...participantIds.map(id => ({ scope: "participant", id }))];
  const rows = database.prepare(`WITH requested(scope,owner_id) AS (VALUES ${owners.map(() => "(?,?)").join(",")})
    SELECT requested.scope,requested.owner_id,authority.revision,typeof(authority.revision) AS revision_type,
      CASE requested.scope
        WHEN 'workspace' THEN EXISTS(SELECT 1 FROM workspaces WHERE id=requested.owner_id)
        WHEN 'channel' THEN EXISTS(SELECT 1 FROM channels WHERE id=requested.owner_id AND workspace_id=?)
        WHEN 'participant' THEN EXISTS(SELECT 1 FROM ai_teammates WHERE id=requested.owner_id AND workspace_id=?)
      END AS owner_exists
    FROM requested LEFT JOIN ${table} AS authority ON authority.scope=requested.scope AND authority.owner_id=requested.owner_id`)
    .all(...owners.flatMap(owner => [owner.scope, owner.id]), input.workspaceId, input.workspaceId);
  if (rows.length !== owners.length || rows.some(row => row.owner_exists !== 1 || row.revision_type !== "integer"
    || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0)) {
    throw new Error("channel_pending_authority.unavailable");
  }
  const revision = (scope: string, id: string) => rows.find(row => row.scope === scope && row.owner_id === id)!.revision as number;
  return { workspaceRevision: revision("workspace", input.workspaceId), channelRevision: revision("channel", input.channelId),
    participants: participantIds.map(participantId => ({ participantId, revision: revision("participant", participantId) })) };
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
