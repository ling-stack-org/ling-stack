import type { DatabaseSync } from "node:sqlite";
import { SqliteRuntimeConcurrencyPolicyStore } from "./runtime-concurrency-policy-store.js";
import { readRuntimeRunCapacityConflict } from "./runtime-run-capacity.js";
import { readRuntimeSemaphoreCapacity } from "./workflow-step-admission-capacity.js";

/** Runs inside the child identity or resume writer transaction, before any new claim. */
export function hasRuntimeDelegationCapacity(database: DatabaseSync, input: {
  readonly workspaceId: string;
  readonly providerKey: string;
  readonly runnerId: string;
  readonly reservedRunId?: string;
  readonly now: string;
}): boolean {
  const policy = new SqliteRuntimeConcurrencyPolicyStore({ database }).getRuntimeConcurrencyPolicy(input.workspaceId);
  if (!policy?.enabled) return true;
  const scope = { workspaceId: input.workspaceId, excludeDelegationRunId: input.reservedRunId, now: input.now };
  if (readRuntimeRunCapacityConflict(database, scope)) return false;
  const provider = readRuntimeSemaphoreCapacity(database, { ...scope, resourceType: "provider",
    resourceKey: input.providerKey, limit: policy.limits.maxRunsPerProvider });
  const runner = readRuntimeSemaphoreCapacity(database, { ...scope, resourceType: "runner",
    resourceKey: input.runnerId, limit: policy.limits.maxRunsPerRunner });
  return provider.occupied < provider.limit && runner.occupied < runner.limit;
}
