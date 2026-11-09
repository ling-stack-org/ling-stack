import {
  parseWorkflowStepExecutionSafety,
  WorkflowSafetyValidationError,
  type WorkflowStepExecutionSafety,
} from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";

export function readWorkflowStepSafety(value: unknown): WorkflowStepExecutionSafety | undefined {
  try {
    return parseWorkflowStepExecutionSafety(value);
  } catch (error) {
    if (error instanceof WorkflowSafetyValidationError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
}

/** Declarations request a profile; only Host admission can grant that profile. */
export function compileWorkflowStepSafety(
  value: unknown,
  limits: {
    readonly maxConcurrentRuns: number;
    readonly maxParallelSteps?: number;
    readonly legacyMaxParallelSiblings?: number;
  },
): WorkflowStepExecutionSafety {
  const safety = readWorkflowStepSafety(value) ?? {
    sideEffectClass: "workspace_write" as const,
    parallelPolicy: { autoParallel: false },
  };
  const declaredLimit = safety.parallelPolicy?.maxParallelSiblings;
  const legacyLimit = limits.legacyMaxParallelSiblings;
  for (const limit of [declaredLimit, legacyLimit, limits.maxParallelSteps]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > limits.maxConcurrentRuns)) {
      throw new HttpError(400, "workflow_safety_parallel_limit", "Workflow parallel limits must be positive safe integers within the channel limit");
    }
  }
  if (declaredLimit !== undefined && legacyLimit !== undefined && declaredLimit !== legacyLimit) {
    throw new HttpError(400, "workflow_safety_parallel_limit_conflict", "maxParallelSiblings conflicts with parallelPolicy.maxParallelSiblings");
  }
  if (!safety.parallelPolicy) {
    return { ...safety, parallelPolicy: { autoParallel: false } };
  }
  return {
    ...safety,
    parallelPolicy: {
      ...safety.parallelPolicy,
      maxParallelSiblings: Math.min(
        declaredLimit ?? legacyLimit ?? limits.maxParallelSteps ?? 1,
        limits.maxParallelSteps ?? limits.maxConcurrentRuns,
      ),
    },
  };
}
