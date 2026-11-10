import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applyProcedureObservationJobMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(184)) return;
  context.database.exec(`
    CREATE TABLE IF NOT EXISTS procedure_observation_jobs (
      workspace_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      observation_id TEXT NOT NULL REFERENCES procedure_observations(id) ON DELETE CASCADE,
      PRIMARY KEY (workspace_id, job_key)
    );
    INSERT OR IGNORE INTO procedure_observation_jobs(workspace_id, job_key, observation_id)
      SELECT observations.workspace_id, json_extract(ref.value, '$.id'), observations.id
      FROM procedure_observations AS observations,
        json_each(CASE WHEN json_valid(observations.source_refs_json) THEN observations.source_refs_json ELSE '[]' END) AS ref
      WHERE json_extract(ref.value, '$.type') = 'observation-job'
        AND typeof(json_extract(ref.value, '$.id')) = 'text' AND length(json_extract(ref.value, '$.id')) > 0
      ORDER BY observations.created_at, observations.id;
  `);
  context.recordMigration(184, "procedure_observation_unique_source_jobs");
}
