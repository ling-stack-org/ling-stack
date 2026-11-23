import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  WorkIntakeBudget, WorkIntakeQuietHours, NativeWorkIntakeSourceKind, WorkItemPriority,
} from "@ling-stack/contracts";
import { isRecord } from "../shared/validation.js";
import { parseIntakeBudget, parseIntakeQuietHours } from "../features/work-items/intake-policy.js";

export interface NativeWorkIntakeConfig {
  readonly workspaceRoot: string;
  readonly sourceKind: NativeWorkIntakeSourceKind;
  readonly sourceScope: string;
  readonly mode?: "manual" | "suggest" | "auto_start";
  readonly enabled?: boolean;
  readonly priority?: WorkItemPriority;
  readonly quietHours?: WorkIntakeQuietHours;
  readonly budget?: WorkIntakeBudget;
}

export type NativeWorkIntakePolicy = Required<Pick<NativeWorkIntakeConfig, "mode" | "enabled" | "priority">> &
  NativeWorkIntakeConfig & { readonly policyId: string; readonly policyRevision: string };

export function resolveNativeWorkIntakePolicies(configured?: readonly NativeWorkIntakeConfig[]): readonly NativeWorkIntakePolicy[] {
  const file = process.env.LING_STACK_APP_SERVER_NATIVE_INTAKE_FILE;
  let sources: unknown = configured;
  if (sources === undefined && file) {
    try { sources = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("The native Work Item intake policy file must contain valid JSON."); }
  }
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length > 128) throw new Error("Native Work Item intake policies must be a bounded array.");
  const seen = new Set<string>();
  return sources.map((source: unknown) => {
    if (!isRecord(source) || typeof source.workspaceRoot !== "string" || !isAbsolute(source.workspaceRoot)
      || source.sourceKind !== "channel_task" && source.sourceKind !== "automation_run"
      || typeof source.sourceScope !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(source.sourceScope)
      || source.mode !== undefined && source.mode !== "manual" && source.mode !== "suggest" && source.mode !== "auto_start"
      || source.enabled !== undefined && typeof source.enabled !== "boolean"
      || source.priority !== undefined && source.priority !== "low" && source.priority !== "normal"
        && source.priority !== "high" && source.priority !== "urgent") {
      throw new Error("Invalid native Work Item intake policy.");
    }
    const workspaceRoot = realpathSync(source.workspaceRoot);
    const key = JSON.stringify([workspaceRoot, source.sourceKind, source.sourceScope]);
    if (seen.has(key)) throw new Error("Duplicate native Work Item intake policy for a source.");
    seen.add(key);
    const mode = source.mode ?? "manual";
    const enabled = source.enabled ?? true;
    const priority = source.priority ?? "normal";
    const budget = mode === "auto_start" ? parseIntakeBudget(source.budget) : undefined;
    const quietHours = parseIntakeQuietHours(source.quietHours);
    return nativeWorkIntakePolicy({ workspaceRoot, sourceKind: source.sourceKind, sourceScope: source.sourceScope,
      mode, enabled, priority, budget, quietHours });
  });
}

export function nativeWorkIntakePolicy(config: NativeWorkIntakeConfig): NativeWorkIntakePolicy {
  const { workspaceRoot, sourceKind, sourceScope, mode = "manual", enabled = true, priority = "normal", budget, quietHours } = config;
  const policyId = createHash("sha256").update(JSON.stringify([workspaceRoot, sourceKind, sourceScope])).digest("hex");
  const policyRevision = createHash("sha256").update(JSON.stringify([policyId, mode, enabled, priority, budget, quietHours])).digest("hex");
  return { workspaceRoot, sourceKind, sourceScope, policyId, policyRevision, mode, enabled, priority, budget, quietHours };
}
