import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ManagedPluginContributionDescriptor,
  ManagedPluginDescriptor,
  ManagedPluginSourceKind,
} from "@ling-stack/core";
import {
  validateLingPluginPackageManifest,
  type LingPluginPackageContribution,
  type LingPluginPackageManifest,
} from "@ling-stack/plugin-sdk";

export interface PluginPackageValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly compiledDescriptor?: ManagedPluginDescriptor;
}

export interface LoadedPluginPackage {
  readonly id: string;
  readonly sourceKind: "bundled" | "trusted-local";
  readonly manifest: LingPluginPackageManifest;
  readonly packageRoot: string;
  readonly validation: PluginPackageValidationResult;
}

export function loadPluginPackageFromRoot(packageRoot: string): LoadedPluginPackage {
  const manifest = readPluginPackageManifest(packageRoot);
  const validation = validatePluginPackageManifestAtRoot(manifest, packageRoot);
  return {
    id: manifest.id,
    sourceKind: manifest.sourceKind,
    manifest,
    packageRoot,
    validation,
  };
}

export function readPluginPackageManifest(packageRoot: string): LingPluginPackageManifest {
  const manifestPath = resolve(packageRoot, ".ling-plugin", "plugin.json");
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as LingPluginPackageManifest;
}

export function validatePluginPackageManifestAtRoot(
  manifest: LingPluginPackageManifest,
  packageRoot: string,
): PluginPackageValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    validateLingPluginPackageManifest(manifest);
  } catch (error) {
    errors.push(redactValidationMessage(error));
  }

  if (Array.isArray(manifest.contributions)) {
    errors.push(...validateContributionPaths(packageRoot, manifest.contributions));
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    errors: [],
    warnings,
    compiledDescriptor: compilePluginPackageManifest(manifest),
  };
}

export function compilePluginPackageManifest(manifest: LingPluginPackageManifest): ManagedPluginDescriptor {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    version: manifest.version,
    sourceKind: toManagedSourceKind(manifest.sourceKind),
    description: manifest.description,
    homepageUrl: manifest.homepageUrl,
    trustSummary: manifest.trustSummary,
    contributions: manifest.contributions.map(packageContributionToManagedContribution),
    requiredSecrets: manifest.requiredSecrets,
    defaultApprovals: manifest.defaultApprovals,
    healthChecks: manifest.healthChecks,
    defaultEnabled: false,
  };
}

function packageContributionToManagedContribution(
  contribution: LingPluginPackageContribution,
): ManagedPluginContributionDescriptor {
  return {
    kind: contribution.kind,
    id: contribution.id,
    label: contribution.id,
    capabilities: [contribution.id],
    sideEffectLevel: contribution.kind === "mcp-server" ? "external" : undefined,
    defaultApproval: contribution.kind === "mcp-server" ? "ask" : undefined,
  };
}

function toManagedSourceKind(sourceKind: LingPluginPackageManifest["sourceKind"]): ManagedPluginSourceKind {
  return sourceKind === "bundled" ? "bundled" : "trusted-local-preset";
}

function validateContributionPaths(
  packageRoot: string,
  contributions: readonly LingPluginPackageContribution[],
): readonly string[] {
  const errors: string[] = [];
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(packageRoot);
  } catch {
    return ["Plugin package root is not readable."];
  }

  for (const contribution of contributions) {
    const path = contribution.path;
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
      errors.push(`Contribution ${contribution.id} path must be relative to the plugin package root.`);
      continue;
    }
    const normalized = path.replace(/^[.][\\/]+/, "");
    const segments = normalized.split(/[\\/]+/);
    if (!normalized || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      errors.push(`Contribution ${contribution.id} path must not contain empty, current, or parent path segments.`);
      continue;
    }

    const targetPath = resolve(packageRoot, path);
    let targetRealPath: string;
    try {
      targetRealPath = realpathSync(targetPath);
    } catch {
      errors.push(`Contribution ${contribution.id} path does not exist inside the plugin package.`);
      continue;
    }
    if (!isPathInside(rootRealPath, targetRealPath)) {
      errors.push(`Contribution ${contribution.id} path escapes the plugin package root.`);
    }
  }

  return errors;
}

function isPathInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function redactValidationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/[^\s"'`]+/g, "[REDACTED_PATH]");
}
