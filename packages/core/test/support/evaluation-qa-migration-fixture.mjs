import assert from "node:assert/strict";
import { RUN_EVALUATION_QA_SCHEMA_OBJECTS, RUN_EVALUATION_QA_MIGRATION_NAME } from "../../dist/storage/sqlite/run-evaluation-qa-migration.js";
import { removeHumanOverlayForLegacyFixture } from "./evaluation-human-migration-fixture.mjs";

/** Exact empty latest overlay removal, solely for authored historical migration fixtures. */
export function removeQaOverlayForLegacyFixture(database) {
  removeHumanOverlayForLegacyFixture(database);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=159").get()?.name, RUN_EVALUATION_QA_MIGRATION_NAME);
  for (const table of ["run_evaluation_qa_requests", "run_evaluation_qa_enrollments", "run_evaluation_qa_batches", "run_evaluation_qa_namespace"]) assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `fixture must not delete QA facts: ${table}`);
  for (const name of RUN_EVALUATION_QA_SCHEMA_OBJECTS.filter(name => !name.startsWith("sqlite_autoindex_"))) {
    const object = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    assert.ok(object, `authored QA object exists: ${name}`);
    if (object.type === "trigger" || object.type === "index") database.exec(`DROP ${object.type.toUpperCase()} ${name}`);
  }
  database.exec("DROP TABLE run_evaluation_qa_requests; DROP TABLE run_evaluation_qa_enrollments; DROP TABLE run_evaluation_qa_batches; DROP TABLE run_evaluation_qa_namespace");
  database.prepare("DELETE FROM schema_migrations WHERE version=159 AND name=?").run(RUN_EVALUATION_QA_MIGRATION_NAME);
}
