import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../../../core/dist/index.js";

interface EmptyStoreTemplate {
  readonly root: string;
  readonly databasePath: string;
}

let template: Promise<EmptyStoreTemplate> | undefined;

after(async () => {
  const initialized = await template?.catch(() => undefined);
  if (initialized) await rm(initialized.root, { recursive: true, force: true });
});

async function createEmptyStoreTemplate(): Promise<EmptyStoreTemplate> {
  const root = await mkdtemp(join(tmpdir(), "ling-stack-empty-store-template-"));
  try {
    const store = createSqliteRunStore(root);
    try {
      return { root, databasePath: store.paths.databasePath };
    } finally {
      // Close the only connection before copying, including SQLite's WAL checkpoint.
      store.close();
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Opt-in database fixture, not a Store factory: runtime construction stays real. */
export async function createSqliteWorkspaceFixture(prefix: string): Promise<string> {
  const cwd = await mkdtemp(prefix);
  try {
    template ??= createEmptyStoreTemplate();
    const initialized = await template;
    const paths = resolveRuntimePaths(cwd);
    await mkdir(paths.rootDir, { recursive: true });
    await copyFile(initialized.databasePath, paths.databasePath, constants.COPYFILE_EXCL);
    return cwd;
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}
