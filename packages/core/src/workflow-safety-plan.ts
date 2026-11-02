import { createHash } from "node:crypto";
import { parseWorkflowStepExecutionSafety, type WorkflowStepExecutionSafety } from "@ling-stack/contracts";
import type { RunTool } from "./approval-policy.js";

/** Host scope, frozen before approval. Runtime identities never enter this plan. */
export interface WorkflowStepSafetyPlanV1 {
  readonly schemaVersion: 1;
  readonly profile: "pi_host_readonly_v1" | "serial_v1";
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly workspaceRoot: string;
  readonly executionRoot: string;
  readonly safety: WorkflowStepExecutionSafety;
  readonly tools: readonly RunTool[];
  readonly skillFingerprint?: string;
  readonly runnerId?: string;
  readonly networkAccess: false | "session_policy";
  readonly writeRoots: readonly string[];
  readonly digest: string;
}

export function workflowStepSafetyPlanDigest(plan: Omit<WorkflowStepSafetyPlanV1, "digest">): string {
  return `wsp1_${createHash("sha256").update(JSON.stringify({
    schemaVersion: plan.schemaVersion, profile: plan.profile,
    workflowId: plan.workflowId, workflowStepId: plan.workflowStepId,
    workspaceRoot: plan.workspaceRoot, executionRoot: plan.executionRoot,
    safety: plan.safety, tools: plan.tools,
    skillFingerprint: plan.skillFingerprint, runnerId: plan.runnerId,
    networkAccess: plan.networkAccess, writeRoots: plan.writeRoots,
  })).digest("hex")}`;
}

export function isWorkflowStepSafetyPlanV1(value: unknown): value is WorkflowStepSafetyPlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !["pi_host_readonly_v1", "serial_v1"].includes(String(v.profile))
    || ![v.workflowId, v.workflowStepId, v.workspaceRoot, v.executionRoot, v.digest].every(s => typeof s === "string" && s.length > 0)
    || v.networkAccess !== false && v.networkAccess !== "session_policy"
    || !Array.isArray(v.writeRoots) || v.writeRoots.some(p => typeof p !== "string")
    || !Array.isArray(v.tools) || v.tools.some(t => !["read", "grep", "find", "ls", "bash", "edit", "write"].includes(t))
    || new Set(v.tools).size !== v.tools.length
    || v.skillFingerprint !== undefined && typeof v.skillFingerprint !== "string"
    || v.runnerId !== undefined && typeof v.runnerId !== "string") return false;
  try {
    if (!parseWorkflowStepExecutionSafety(v.safety)) return false;
    const plan = value as WorkflowStepSafetyPlanV1;
    return workflowStepSafetyPlanDigest(plan) === plan.digest
      && (plan.profile !== "pi_host_readonly_v1"
        || plan.safety.sideEffectClass === "analysis_readonly" && plan.runnerId === "pi"
          && plan.networkAccess === false && plan.writeRoots.length === 0
          && plan.tools.every(t => ["read", "grep", "find", "ls"].includes(t)));
  } catch { return false; }
}
