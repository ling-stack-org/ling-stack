import type { SQLOutputValue } from "node:sqlite";
import {
  validateRuntimeConcurrencyLimits,
  type InstallRuntimeConcurrencyPolicyInput,
  type InstallRuntimeConcurrencyPolicyResult,
  type RuntimeConcurrencyLimits,
  type RuntimeConcurrencyPolicy,
} from "../../runtime-concurrency-policy.js";
import { readNumber, readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME, RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION }
  from "./runtime-concurrency-policy-migration.js";
import { RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION }
  from "./runtime-concurrency-policy-activation-migration.js";

const columns = `workspace_id,runtime_instance_id,revision,max_concurrent_runs,max_read_only_runs,
  max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at`;

function nonemptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`Runtime concurrency policy ${field} must be a string.`);
  if (!value.trim() || value.includes("\0")) throw new RangeError(`Runtime concurrency policy ${field} must be nonempty text.`);
}

function revision(value: unknown, minimum: number): asserts value is number {
  if (typeof value !== "number") throw new TypeError("Runtime concurrency policy revision must be a number.");
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`Runtime concurrency policy revision must be a safe integer of at least ${minimum}.`);
  }
}

function timestamp(value: unknown): asserts value is string {
  nonemptyString(value, "installedAt");
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError("Runtime concurrency policy installedAt must be a canonical UTC timestamp.");
  }
}

function sameLimits(left: RuntimeConcurrencyLimits, right: RuntimeConcurrencyLimits): boolean {
  return (Object.keys(left) as (keyof RuntimeConcurrencyLimits)[]).every(key => left[key] === right[key]);
}

function policyFromRow(row: Record<string, SQLOutputValue>): RuntimeConcurrencyPolicy {
  const workspaceId = readString(row, "workspace_id"), runtimeInstanceId = readString(row, "runtime_instance_id");
  const installedAt = readString(row, "installed_at"), policyRevision = readNumber(row, "revision");
  nonemptyString(workspaceId, "workspaceId");
  nonemptyString(runtimeInstanceId, "runtimeInstanceId");
  timestamp(installedAt);
  revision(policyRevision, 1);
  if (row.enabled !== 0 && row.enabled !== 1) throw new Error("runtime_concurrency_policy.activation_invalid");
  return Object.freeze({ workspaceId, runtimeInstanceId, revision: policyRevision, enabled: row.enabled === 1, installedAt,
    limits: validateRuntimeConcurrencyLimits({
      maxConcurrentRuns: readNumber(row, "max_concurrent_runs"),
      maxReadOnlyRuns: readNumber(row, "max_read_only_runs"),
      maxWorkspaceWriteRuns: readNumber(row, "max_workspace_write_runs"),
      maxRunsPerProvider: readNumber(row, "max_runs_per_provider"),
      maxRunsPerRunner: readNumber(row, "max_runs_per_runner"),
    }),
  });
}

export class SqliteRuntimeConcurrencyPolicyStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getRuntimeConcurrencyPolicy(workspaceId: string): RuntimeConcurrencyPolicy | undefined {
    nonemptyString(workspaceId, "workspaceId");
    if (!this.hasPolicySchema()) return undefined;
    const activationColumn = this.hasActivationSchema() ? "enabled" : "1 AS enabled";
    const row = this.context.database.prepare(`SELECT ${columns},${activationColumn} FROM runtime_concurrency_policies WHERE workspace_id=?`).get(workspaceId);
    return row ? policyFromRow(row) : undefined;
  }

  private hasPolicySchema(): boolean {
    const { database } = this.context;
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME);
    const table = database.prepare("SELECT type FROM sqlite_master WHERE name=?").get(RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME);
    if (!markers.length && !table
      && Number(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0)
        < RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION) return false;
    if (markers.length !== 1 || markers[0]!.version !== RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION
      || markers[0]!.name !== RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME || table?.type !== "table") {
      throw new Error("runtime_concurrency_policy.schema_invalid");
    }
    return true;
  }

  private hasActivationSchema(): boolean {
    const { database } = this.context;
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME);
    const column = database.prepare("PRAGMA table_info(runtime_concurrency_policies)").all().find(row => row.name === "enabled");
    if (!markers.length && !column
      && Number(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0)
        < RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION) return false;
    if (markers.length !== 1 || markers[0]!.version !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION
      || markers[0]!.name !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME || column?.type !== "INTEGER"
      || column.notnull !== 1 || column.dflt_value !== "1" || column.pk !== 0) {
      throw new Error("runtime_concurrency_policy.activation_schema_invalid");
    }
    return true;
  }

  /** Supervisor ownership is external; revisions fence policy installation, not process liveness. */
  installRuntimeConcurrencyPolicy(input: InstallRuntimeConcurrencyPolicyInput): InstallRuntimeConcurrencyPolicyResult {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Runtime concurrency policy installation must be an object.");
    }
    const { workspaceId, runtimeInstanceId, expectedRevision, installedAt } = input;
    nonemptyString(workspaceId, "workspaceId");
    nonemptyString(runtimeInstanceId, "runtimeInstanceId");
    revision(expectedRevision, 0);
    timestamp(installedAt);
    const limits = validateRuntimeConcurrencyLimits(input.limits);
    const activation = Object.getOwnPropertyDescriptor(input, "enabled");
    if (activation && (!("value" in activation) || typeof activation.value !== "boolean")) {
      throw new TypeError("Runtime concurrency policy enabled must be a boolean data property.");
    }
    const enabled = activation ? activation.value as boolean : true;
    const { database } = this.context;
    // A failed nested BEGIN must not enter the rollback boundary owned by this operation.
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasPolicySchema()) throw new Error("runtime_concurrency_policy.schema_unavailable");
      const activationSchema = this.hasActivationSchema();
      if (!activationSchema && !enabled) throw new Error("runtime_concurrency_policy.activation_schema_unavailable");
      const current = this.getRuntimeConcurrencyPolicy(workspaceId);
      let result: InstallRuntimeConcurrencyPolicyResult;
      if (current?.runtimeInstanceId === runtimeInstanceId) {
        result = current.enabled === enabled && sameLimits(current.limits, limits)
          ? { status: "duplicate", policy: current } : { status: "changed" };
      } else if ((current?.revision ?? 0) !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) {
        result = { status: "changed" };
      } else {
        const values = [runtimeInstanceId, expectedRevision + 1, limits.maxConcurrentRuns, limits.maxReadOnlyRuns,
          limits.maxWorkspaceWriteRuns, limits.maxRunsPerProvider, limits.maxRunsPerRunner, installedAt,
          ...(activationSchema ? [enabled ? 1 : 0] : []), workspaceId];
        const written = current
          ? database.prepare(`UPDATE runtime_concurrency_policies SET runtime_instance_id=?,revision=?,max_concurrent_runs=?,
              max_read_only_runs=?,max_workspace_write_runs=?,max_runs_per_provider=?,max_runs_per_runner=?,installed_at=?
              ${activationSchema ? ",enabled=?" : ""}
              WHERE workspace_id=? AND revision=?`).run(...values, expectedRevision)
          : database.prepare(`INSERT INTO runtime_concurrency_policies(runtime_instance_id,revision,max_concurrent_runs,
              max_read_only_runs,max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at,
              ${activationSchema ? "enabled," : ""}workspace_id)
              VALUES(${values.map(() => "?").join(",")}) ON CONFLICT(workspace_id) DO NOTHING`).run(...values);
        if (Number(written.changes) !== 1) result = { status: "changed" };
        else {
          const policy = this.getRuntimeConcurrencyPolicy(workspaceId);
          if (!policy || policy.runtimeInstanceId !== runtimeInstanceId || policy.revision !== expectedRevision + 1
            || policy.enabled !== enabled || policy.installedAt !== installedAt || !sameLimits(policy.limits, limits)) {
            throw new Error("runtime_concurrency_policy.install_postcondition");
          }
          result = { status: "installed", policy };
        }
      }
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }
}
