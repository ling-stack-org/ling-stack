import type { RunnerNativeSideEffectMode, RunnerToolSideEffectClass } from "@ling-stack/contracts";
import type { RegisteredRunner } from "./runners.js";

export interface RunnerToolExecutionConformanceV1 {
  /** Must exactly match the registered adapter revision. */
  readonly adapterRevision: string;
  readonly curatedTools: readonly string[];
  readonly toolSideEffects: Readonly<Record<string, RunnerToolSideEffectClass>>;
  readonly allowedSideEffects: readonly RunnerToolSideEffectClass[];
  readonly nativeSideEffectMode: RunnerNativeSideEffectMode;
  readonly toolSurfaceCurated: boolean;
  readonly approvalBridgeVerified: boolean;
  readonly sandboxBindingVerified: boolean;
  readonly evidenceCommitVerified: boolean;
  readonly abortPropagationVerified: boolean;
  readonly attemptFencingVerified: boolean;
  readonly workspaceBoundaryVerified: boolean;
  readonly artifactImportVerified: boolean;
}

export type RunnerToolExecutionGateBlocker =
  | "runner_disabled"
  | "tool_conformance_revision_mismatch"
  | "tool_surface_not_curated"
  | "tool_not_curated"
  | "tool_side_effect_unclassified"
  | "tool_side_effect_mismatch"
  | "tool_side_effect_not_allowed"
  | "tool_side_effect_mode_unverified"
  | "native_side_effects_disabled"
  | "approval_bridge_not_verified"
  | "sandbox_binding_not_verified"
  | "evidence_commit_not_verified"
  | "abort_propagation_not_verified"
  | "attempt_fencing_not_verified"
  | "workspace_boundary_not_verified";

export interface RunnerToolExecutionGateV1 {
  readonly ok: boolean;
  readonly adapterRevision: string;
  readonly blockers: readonly RunnerToolExecutionGateBlocker[];
}

export function createUnverifiedToolExecutionConformance(
  adapterRevision: string,
): RunnerToolExecutionConformanceV1 {
  return {
    adapterRevision,
    curatedTools: [],
    toolSideEffects: {},
    allowedSideEffects: [],
    nativeSideEffectMode: "unverified",
    toolSurfaceCurated: false,
    approvalBridgeVerified: false,
    sandboxBindingVerified: false,
    evidenceCommitVerified: false,
    abortPropagationVerified: false,
    attemptFencingVerified: false,
    workspaceBoundaryVerified: false,
    artifactImportVerified: false,
  };
}

export function resolveRunnerToolExecutionGate(
  runner: RegisteredRunner,
  requestedTools: readonly string[],
  expectedAdapterRevision?: string,
): RunnerToolExecutionGateV1 {
  const blockers: RunnerToolExecutionGateBlocker[] = [];
  if (runner.status !== "enabled") blockers.push("runner_disabled");
  if (runner.executionBoundary !== "external") {
    return { ok: blockers.length === 0, adapterRevision: runner.adapterRevision, blockers };
  }
  const receipt = runner.toolExecutionConformance;
  if (receipt.adapterRevision !== runner.adapterRevision || (
    expectedAdapterRevision !== undefined && expectedAdapterRevision !== receipt.adapterRevision
  )) {
    blockers.push("tool_conformance_revision_mismatch");
  }
  if (!receipt.toolSurfaceCurated) blockers.push("tool_surface_not_curated");
  const curatedTools = new Set(receipt.curatedTools);
  const allowedSideEffects = new Set(receipt.allowedSideEffects);
  let requiresWorkspaceBoundary = false;
  let requiresSideEffectParity = false;
  for (const tool of requestedTools) {
    if (!curatedTools.has(tool)) blockers.push("tool_not_curated");
    const sideEffect = runner.toolSideEffects[tool];
    const receiptSideEffect = receipt.toolSideEffects[tool];
    if (!sideEffect || !receiptSideEffect) {
      blockers.push("tool_side_effect_unclassified");
      continue;
    }
    if (sideEffect !== receiptSideEffect) blockers.push("tool_side_effect_mismatch");
    if (!allowedSideEffects.has(sideEffect)) blockers.push("tool_side_effect_not_allowed");
    if (sideEffect === "workspace_read" || sideEffect === "workspace_write" || sideEffect === "shell") {
      requiresWorkspaceBoundary = true;
    }
    if (sideEffect !== "none" && sideEffect !== "workspace_read") {
      requiresSideEffectParity = true;
    }
  }
  if (receipt.nativeSideEffectMode === "unverified") blockers.push("tool_side_effect_mode_unverified");
  if (requiresSideEffectParity) {
    if (receipt.nativeSideEffectMode === "disabled") blockers.push("native_side_effects_disabled");
    if (!receipt.approvalBridgeVerified) blockers.push("approval_bridge_not_verified");
    if (!receipt.sandboxBindingVerified) blockers.push("sandbox_binding_not_verified");
  }
  if (requestedTools.length > 0) {
    if (!receipt.evidenceCommitVerified) blockers.push("evidence_commit_not_verified");
    if (!receipt.abortPropagationVerified) blockers.push("abort_propagation_not_verified");
    if (!receipt.attemptFencingVerified) blockers.push("attempt_fencing_not_verified");
  }
  if (requiresWorkspaceBoundary && !receipt.workspaceBoundaryVerified) {
    blockers.push("workspace_boundary_not_verified");
  }
  return {
    ok: blockers.length === 0,
    adapterRevision: runner.adapterRevision,
    blockers: [...new Set(blockers)],
  };
}
