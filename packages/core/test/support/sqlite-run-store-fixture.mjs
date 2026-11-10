import { copyFileSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createSqliteRunStore, ensureRuntimePaths, resolveRuntimePaths } from "../../dist/index.js";

/** @type {{ directory: string, databasePath: string } | undefined} */
let template;

/**
 * Build the current schema and builtin seeds through the real production
 * factory once per test process. The template has no test-owned business rows
 * or open connections. It never persists across test runs or Core builds.
 *
 * @returns {string} The closed, fully checkpointed main database path.
 */
function templateDatabasePath() {
  if (template) return template.databasePath;

  const directory = mkdtempSync(join(tmpdir(), "ling-sqlite-fixture-template-"));
  /** @type {import("../../dist/index.js").SqliteRunStore | undefined} */
  let store;
  try {
    const paths = resolveRuntimePaths(directory);
    assertRepoLocal(paths);
    store = createSqliteRunStore(directory, paths);
    const checkpoint = store.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
      throw new Error("SQLite fixture template checkpoint is incomplete");
    }
    store.close();
    store = undefined;
    template = { directory, databasePath: paths.databasePath };
    return template.databasePath;
  } catch (error) {
    // Cleanup must preserve the original initialization/checkpoint failure.
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

/** @param {import("../../dist/index.js").LingStackRuntimePaths} paths */
function assertRepoLocal(paths) {
  if (paths.stateLocation !== "repo-local") {
    throw new Error("SQLite fixture requires repo-local state");
  }
}

/**
 * Create an independent real Store for ordinary business-logic tests.
 *
 * Each caller owns its temporary cwd and the returned Store's lifetime. Copy
 * only the closed main database: WAL/SHM, recovery snapshots and manifests are
 * tied to the template's original cwd and must not become the test's recovery
 * evidence. COPYFILE_EXCL refuses an existing database, including one already
 * opened by another connection. Existing WAL/SHM files are also refused so
 * SQLite cannot replay stale pages into the copy. Reopens and secondary
 * connections must use the normal production factory against this same test database.
 *
 * Use the production factory directly for migrations, first initialization,
 * recovery, builtin seed generation, or constructor-option tests. This helper
 * intentionally shares initial seed timestamps/IDs across isolated copies.
 *
 * @param {string} cwd An existing test-owned temporary directory.
 * @returns {import("../../dist/index.js").SqliteRunStore}
 */
export function createSqliteRunStoreFixture(cwd) {
  const paths = resolveRuntimePaths(cwd);
  assertRepoLocal(paths);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = paths.databasePath + suffix;
    if (existsSync(sidecar)) {
      throw Object.assign(new Error(`SQLite fixture refuses an existing sidecar: ${sidecar}`), {
        code: "EEXIST", path: sidecar,
      });
    }
  }
  const source = templateDatabasePath();
  ensureRuntimePaths(paths);
  copyFileSync(source, paths.databasePath, constants.COPYFILE_EXCL);
  return createSqliteRunStore(cwd, paths);
}

after(() => {
  if (!template) return;
  const { directory } = template;
  template = undefined;
  rmSync(directory, { recursive: true, force: true });
});
