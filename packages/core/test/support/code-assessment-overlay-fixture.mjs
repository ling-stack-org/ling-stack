import assert from "node:assert/strict";

const tables = ["code_assessment_comments", "code_assessment_findings", "code_assessments", "code_assessment_snapshots"];
const markers = [
  [223, "code_assessments"], [224, "code_assessment_lifecycle"], [225, "code_assessment_comments"], [226, "code_assessment_history_filters"],
];

/** Remove the code-assessment overlay from an owned temporary database used by a pre-223 migration fixture. */
export function dropCodeAssessmentOverlay(database) {
  const markerRows = database.prepare("SELECT version,name FROM schema_migrations WHERE version>=223 ORDER BY version").all();
  assert.deepEqual(markerRows.map(({ version, name }) => [version, name]), markers);
  for (const table of tables) assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} must be empty`);
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of tables) database.exec(`DROP TABLE "${table}"`);
    for (const [version, name] of markers)
      assert.equal(database.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(version, name).changes, 1);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys=ON");
  }
}
