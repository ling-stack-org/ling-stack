import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, renameSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { resolveRuntimePaths } from "@ling-stack/core";
import type { LoadedPluginPackage } from "./manifest.js";
import { loadPluginPackageFromRoot } from "./manifest.js";

export interface MaterializedPluginPackage {
  readonly cacheRef: string;
  readonly packageHash: string;
  readonly packageRoot: string;
  readonly loadedPackage: LoadedPluginPackage;
}

export function materializeBundledPluginPackage(input: {
  readonly cwd: string;
  readonly pluginPackage: LoadedPluginPackage;
  readonly now: string;
}): MaterializedPluginPackage {
  const paths = resolveRuntimePaths(input.cwd);
  const sourceRoot = input.pluginPackage.packageRoot;
  const packageName = packageNameFromPluginId(input.pluginPackage.id);
  const stagingParent = join(paths.pluginCacheDir, ".staging");
  const stagingRoot = join(stagingParent, `${packageName}-${Date.parse(input.now)}-${process.pid}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingParent, { recursive: true });
  cpSync(sourceRoot, stagingRoot, {
    recursive: true,
    errorOnExist: false,
    force: true,
    verbatimSymlinks: true,
  });

  const stagedPackage = loadPluginPackageFromRoot(stagingRoot);
  if (!stagedPackage.validation.ok) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error(`Plugin package validation failed: ${formatValidationErrors(stagedPackage.validation.errors)}`);
  }

  const packageHash = hashDirectory(stagingRoot);
  const cacheRef = `${input.pluginPackage.sourceKind}/${packageName}/${input.pluginPackage.manifest.version}/${packageHash.slice(0, 12)}`;
  const finalRoot = join(paths.pluginCacheDir, cacheRef);
  if (existsSync(finalRoot)) {
    rmSync(stagingRoot, { recursive: true, force: true });
  } else {
    mkdirSync(join(finalRoot, ".."), { recursive: true });
    renameSync(stagingRoot, finalRoot);
  }

  return {
    cacheRef,
    packageHash,
    packageRoot: finalRoot,
    loadedPackage: loadPluginPackageFromRoot(finalRoot),
  };
}

function packageNameFromPluginId(pluginId: string): string {
  const name = pluginId.includes(":") ? pluginId.split(":").slice(1).join("-") : pluginId;
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "plugin";
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const filePath of listFiles(root)) {
    const relativePath = relative(root, filePath).split("\\").join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(root: string): string[] {
  const entries = readdirSync(root)
    .filter((entry) => entry !== ".DS_Store")
    .map((entry) => join(root, entry))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
  const files: string[] = [];
  for (const entry of entries) {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      files.push(...listFiles(entry));
    } else if (stat.isFile()) {
      files.push(entry);
    }
  }
  return files;
}

function formatValidationErrors(errors: readonly unknown[]): string {
  return errors.map((error) => {
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return error.message;
    }
    return "invalid package";
  }).join("; ");
}
