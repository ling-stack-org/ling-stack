import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultDesktopRoot = resolve(dirname(scriptPath), "..");
const productionFileSystem = Object.freeze({ copyFile, mkdir, mkdtemp, readFile, rename, rm });

/** Replace the development-only bundled metadata tree with the configured exact inventory. */
export async function stageDevelopmentBundledPlugins(input = {}) {
  return stageDevelopmentBundledPluginsWithFileSystem(input, productionFileSystem);
}

/** Test-only filesystem seam for deterministic cutover and rollback failures. */
export function createDevelopmentBundledPluginStagerForTest(overrides = {}) {
  const fileSystem = Object.freeze({ ...productionFileSystem, ...overrides });
  return input => stageDevelopmentBundledPluginsWithFileSystem(input, fileSystem);
}

async function stageDevelopmentBundledPluginsWithFileSystem(input, fileSystem) {
  const desktopRoot = resolve(input.desktopRoot ?? defaultDesktopRoot);
  const configuration = JSON.parse(await fileSystem.readFile(resolve(desktopRoot, "package.json"), "utf8"));
  const resources = configuration?.build?.extraResources?.filter(entry => entry?.to === "bundled") ?? [];
  const resource = resources.length === 1 ? resources[0] : undefined;
  if (!resource || typeof resource.from !== "string" || !Array.isArray(resource.filter)) {
    throw new Error("bundled_plugin_metadata_missing");
  }

  const inventory = requireExactInventory(resource.filter);
  const destinationRoot = resolve(desktopRoot, "dist/daemon/bundled");
  await fileSystem.mkdir(dirname(destinationRoot), { recursive: true });
  const workspace = await fileSystem.mkdtemp(resolve(desktopRoot, ".bundled-plugin-stage-"));
  const nextRoot = resolve(workspace, "next");
  const previousRoot = resolve(workspace, "previous");
  let result;
  let operationError;
  try {
    await fileSystem.mkdir(nextRoot, { recursive: true });
    for (const path of inventory) {
      const target = resolve(nextRoot, path);
      await fileSystem.mkdir(dirname(target), { recursive: true });
      await fileSystem.copyFile(resolve(desktopRoot, resource.from, path), target);
    }
    await replaceDirectoryWithRollback({ destinationRoot, fileSystem, nextRoot, previousRoot });
    result = Object.freeze({ destinationRoot, fileCount: inventory.length });
  } catch (error) {
    operationError = error;
  }

  const retainWorkspace = operationError?.code === "bundled_plugin_stage_rollback_failed";
  if (retainWorkspace) {
    operationError.recoveryPath = workspace;
  }
  try {
    if (!retainWorkspace) await fileSystem.rm(workspace, { recursive: true, force: true });
  } catch (cleanupError) {
    if (operationError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        "bundled_plugin_stage_cleanup_failed",
        { cause: operationError },
      );
    }
    throw cleanupError;
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

function requireExactInventory(paths) {
  const inventory = [];
  const seen = new Set();
  for (const path of paths) {
    const segments = typeof path === "string" ? path.split(/[\\/]/u) : [];
    if (
      typeof path !== "string"
      || isAbsolute(path)
      || segments.some(segment => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("bundled_plugin_metadata_path_invalid");
    }
    const normalized = segments.join("/");
    if (seen.has(normalized)) throw new Error("bundled_plugin_metadata_path_duplicate");
    seen.add(normalized);
    inventory.push(normalized);
  }
  return inventory;
}

async function replaceDirectoryWithRollback({ destinationRoot, fileSystem, nextRoot, previousRoot }) {
  let previousMoved = false;
  try {
    await fileSystem.rename(destinationRoot, previousRoot);
    previousMoved = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await fileSystem.rename(nextRoot, destinationRoot);
  } catch (publicationError) {
    if (!previousMoved) throw publicationError;
    try {
      await fileSystem.rename(previousRoot, destinationRoot);
    } catch (rollbackError) {
      const error = new AggregateError(
        [publicationError, rollbackError],
        "bundled_plugin_stage_rollback_failed",
        { cause: publicationError },
      );
      error.code = "bundled_plugin_stage_rollback_failed";
      throw error;
    }
    throw publicationError;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await stageDevelopmentBundledPlugins();
  console.log(`Staged ${result.fileCount} bundled plugin metadata files for development.`);
}
