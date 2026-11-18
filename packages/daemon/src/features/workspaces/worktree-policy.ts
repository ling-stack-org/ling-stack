import { isAbsolute, join, resolve } from "node:path";
import type { WorktreePolicy } from "@ling-stack/contracts";
import type { LingStackRuntimePaths } from "@ling-stack/core";

export const REDACTED_WORKTREE_ENVIRONMENT_VALUE = "[configured]";

/** Keep environment variable names visible while never returning their values. */
export function redactWorktreePolicy(policy: WorktreePolicy | undefined): WorktreePolicy | undefined {
  if (!policy?.environment) return policy;
  return {
    ...policy,
    environment: {
      ...policy.environment,
      variables: Object.fromEntries(Object.keys(policy.environment.variables).map((key) => [key, REDACTED_WORKTREE_ENVIRONMENT_VALUE])),
    },
  };
}

/** Restore unchanged values from a redacted read response before persisting a write. */
export function restoreRedactedWorktreePolicy(
  policy: WorktreePolicy | null | undefined,
  current: WorktreePolicy | undefined,
): WorktreePolicy | null | undefined {
  if (!policy?.environment || !current?.environment) return policy;
  const currentVariables = current.environment.variables;
  return {
    ...policy,
    environment: {
      ...policy.environment,
      variables: Object.fromEntries(Object.entries(policy.environment.variables).map(([key, value]) => [
        key,
        value === REDACTED_WORKTREE_ENVIRONMENT_VALUE && Object.hasOwn(currentVariables, key) ? currentVariables[key] : value,
      ])),
    },
  };
}

export function parseWorktreePolicy(value: unknown): WorktreePolicy | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("worktreePolicy must be an object or null");
  const record = value as Record<string, unknown>;
  if (typeof record.fetchBeforeCreate !== "boolean") throw new Error("worktreePolicy.fetchBeforeCreate must be a boolean");
  if (record.rootDir !== undefined && typeof record.rootDir !== "string") throw new Error("worktreePolicy.rootDir must be a string");
  const rootDir = typeof record.rootDir === "string" ? record.rootDir.trim() : "";
  if (rootDir && (!isAbsolute(rootDir) || rootDir.includes("\0") || rootDir.length > 4096)) {
    throw new Error("worktreePolicy.rootDir must be an absolute directory path");
  }
  for (const key of ["autoCleanup", "confirmBeforeDelete"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") throw new Error(`worktreePolicy.${key} must be a boolean`);
  }
  if (record.retainCount !== undefined && (!Number.isSafeInteger(record.retainCount) || Number(record.retainCount) < 1 || Number(record.retainCount) > 100)) {
    throw new Error("worktreePolicy.retainCount must be an integer between 1 and 100");
  }
  let protectedOwners: WorktreePolicy["protectedOwners"];
  if (record.protectedOwners !== undefined) {
    if (!Array.isArray(record.protectedOwners) || record.protectedOwners.length > 500) throw new Error("Invalid protected worktree owners");
    protectedOwners = record.protectedOwners.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("ownerKind" in item) || !("ownerId" in item)
        || !["channel", "teammate"].includes(String(item.ownerKind)) || typeof item.ownerId !== "string" || !item.ownerId || item.ownerId.length > 256) {
        throw new Error("Invalid protected worktree owner");
      }
      return { ownerKind: item.ownerKind as "channel" | "teammate", ownerId: item.ownerId };
    });
  }
  let environment: WorktreePolicy["environment"];
  if (record.environment !== undefined) {
    const env = record.environment as Record<string, unknown>;
    if (!env || typeof env !== "object" || Array.isArray(env) || typeof env.enabled !== "boolean"
      || typeof env.setupScript !== "string" || env.setupScript.includes("\0") || env.setupScript.length > 8000
      || !Number.isSafeInteger(env.timeoutSeconds) || Number(env.timeoutSeconds) < 1 || Number(env.timeoutSeconds) > 600
      || !env.variables || typeof env.variables !== "object" || Array.isArray(env.variables)) throw new Error("Invalid worktree environment");
    const variables = Object.entries(env.variables);
    if (variables.length > 64 || variables.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof value !== "string" || value.includes("\0") || value.length > 4096)) throw new Error("Invalid worktree environment variables");
    if (env.enabled && !env.setupScript.trim()) throw new Error("Enabled worktree environment requires a setup script");
    environment = { enabled: env.enabled, setupScript: env.setupScript, timeoutSeconds: Number(env.timeoutSeconds), variables: Object.fromEntries(variables) as Record<string, string> };
  }
  return { ...(rootDir ? { rootDir: resolve(rootDir) } : {}), fetchBeforeCreate: record.fetchBeforeCreate,
    ...(record.autoCleanup !== undefined ? { autoCleanup: record.autoCleanup as boolean } : {}),
    ...(record.confirmBeforeDelete !== undefined ? { confirmBeforeDelete: record.confirmBeforeDelete as boolean } : {}),
    ...(record.retainCount !== undefined ? { retainCount: Number(record.retainCount) } : {}),
    ...(protectedOwners ? { protectedOwners } : {}), ...(environment ? { environment } : {}) };
}

export function worktreeRoot(paths: LingStackRuntimePaths, policy?: WorktreePolicy): string {
  return policy?.rootDir ? join(policy.rootDir, paths.identity.workspaceId) : paths.worktreesDir;
}
