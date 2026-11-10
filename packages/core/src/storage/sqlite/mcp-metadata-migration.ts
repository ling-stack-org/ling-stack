import type { DatabaseSync } from "node:sqlite";

export const MCP_METADATA_MIGRATION_VERSION = 155;
const MIGRATION_NAME = "add_mcp_metadata_publication_revisions";

/** Append metadata order/consumption to existing ABA-safe authority tombstones. */
export function applyMcpMetadataMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const marked = input.hasMigration(MCP_METADATA_MIGRATION_VERSION);
  const requestColumn = input.hasColumn("mcp_authority_revisions", "metadata_request_revision");
  const publishedColumn = input.hasColumn("mcp_authority_revisions", "metadata_published_revision");
  const markers = input.database.prepare("SELECT version, name FROM schema_migrations WHERE version = ? OR name = ?")
    .all(MCP_METADATA_MIGRATION_VERSION, MIGRATION_NAME);
  if (markers.some(row => row.version !== MCP_METADATA_MIGRATION_VERSION || row.name !== MIGRATION_NAME)
    || markers.length > 1 || marked !== (markers.length === 1)
    || (marked ? !requestColumn || !publishedColumn : requestColumn || publishedColumn)) {
    throw new Error("MCP metadata migration marker conflicts with existing history.");
  }
  if (marked) return;
  input.database.exec("SAVEPOINT mcp_metadata_migration");
  try {
    input.database.exec(`
      ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision INTEGER NOT NULL DEFAULT 0
        CHECK(typeof(metadata_request_revision) = 'integer' AND metadata_request_revision BETWEEN 0 AND 9007199254740991);
      ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_published_revision INTEGER NOT NULL DEFAULT 0
        CHECK(typeof(metadata_published_revision) = 'integer' AND metadata_published_revision BETWEEN 0 AND metadata_request_revision);
    `);
    input.recordMigration(MCP_METADATA_MIGRATION_VERSION, MIGRATION_NAME);
    input.database.exec("RELEASE mcp_metadata_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO mcp_metadata_migration");
    input.database.exec("RELEASE mcp_metadata_migration");
    throw error;
  }
}
