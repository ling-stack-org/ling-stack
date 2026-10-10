import assert from "node:assert/strict";
import { RUN_EVALUATION_HUMAN_SCHEMA_OBJECTS, RUN_EVALUATION_HUMAN_MIGRATION_NAME } from "../../dist/storage/sqlite/run-evaluation-human-migration.js";
/** Remove only the exact empty authored160 overlay before constructing historical fixtures. */
export function removeHumanOverlayForLegacyFixture(database) {
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=160").get()?.name, RUN_EVALUATION_HUMAN_MIGRATION_NAME);
  for (const table of ["run_evaluation_human_intents", "run_evaluation_human_events", "run_evaluation_human_heads"]) assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `fixture must not delete human facts: ${table}`);
  for (const name of RUN_EVALUATION_HUMAN_SCHEMA_OBJECTS.filter(name => !name.startsWith("sqlite_autoindex_"))) {
    const object = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    assert.ok(object, `authored human object exists: ${name}`);
    if (object.type === "trigger" || object.type === "index") database.exec(`DROP ${object.type.toUpperCase()} ${name}`);
  }
  database.exec("DROP TABLE run_evaluation_human_heads; DROP TABLE run_evaluation_human_events; DROP TABLE run_evaluation_human_intents");
  database.prepare("DELETE FROM schema_migrations WHERE version=160 AND name=?").run(RUN_EVALUATION_HUMAN_MIGRATION_NAME);
}
