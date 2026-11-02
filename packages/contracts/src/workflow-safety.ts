export type WorkflowStepSideEffectClass =
  | "analysis_readonly"
  | "test_artifact_only"
  | "workspace_write"
  | "external_mutation"
  | "release";

export const workflowStepSideEffectClasses: readonly WorkflowStepSideEffectClass[] = [
  "analysis_readonly",
  "test_artifact_only",
  "workspace_write",
  "external_mutation",
  "release",
];

export interface WorkflowStepParallelPolicy {
  readonly autoParallel: boolean;
  readonly maxParallelSiblings?: number;
  readonly resourceKeys?: readonly string[];
  readonly requiresArtifactOnly?: boolean;
  readonly cancelSiblingsOnFailure?: boolean;
}

/** A requested constraint, not evidence of Host capability or execution authority. */
export interface WorkflowStepExecutionSafety {
  readonly sideEffectClass: WorkflowStepSideEffectClass;
  readonly parallelPolicy?: WorkflowStepParallelPolicy;
}

export class WorkflowSafetyValidationError extends Error {
  readonly code = "workflow_safety_invalid";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowSafetyValidationError";
  }
}

const parallelPolicyKeys = new Set([
  "autoParallel",
  "maxParallelSiblings",
  "resourceKeys",
  "requiresArtifactOnly",
  "cancelSiblingsOnFailure",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new WorkflowSafetyValidationError(`parallelPolicy.${field} must be a boolean`);
}

/** Extract only the direct safety fields; missing legacy declarations stay unclassified. */
export function parseWorkflowStepExecutionSafety(value: unknown): WorkflowStepExecutionSafety | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new WorkflowSafetyValidationError("Workflow step safety must be declared on a record");
  }
  const { sideEffectClass, parallelPolicy } = value;
  if (sideEffectClass === undefined && parallelPolicy === undefined) return undefined;
  if (typeof sideEffectClass !== "string"
    || !workflowStepSideEffectClasses.includes(sideEffectClass as WorkflowStepSideEffectClass)) {
    throw new WorkflowSafetyValidationError("sideEffectClass must be a known workflow step side-effect class");
  }
  const safety: WorkflowStepExecutionSafety = {
    sideEffectClass: sideEffectClass as WorkflowStepSideEffectClass,
  };
  if (parallelPolicy === undefined) return safety;
  if (!isRecord(parallelPolicy)
    || !Object.keys(parallelPolicy).every((key) => parallelPolicyKeys.has(key))) {
    throw new WorkflowSafetyValidationError("parallelPolicy must be a record with known policy fields");
  }

  const autoParallel = optionalBoolean(parallelPolicy.autoParallel, "autoParallel") ?? false;
  const requiresArtifactOnly = optionalBoolean(parallelPolicy.requiresArtifactOnly, "requiresArtifactOnly");
  const cancelSiblingsOnFailure = optionalBoolean(parallelPolicy.cancelSiblingsOnFailure, "cancelSiblingsOnFailure");
  const maxParallelSiblings = parallelPolicy.maxParallelSiblings;
  if (maxParallelSiblings !== undefined
    && (typeof maxParallelSiblings !== "number" || !Number.isSafeInteger(maxParallelSiblings) || maxParallelSiblings <= 0)) {
    throw new WorkflowSafetyValidationError("parallelPolicy.maxParallelSiblings must be a positive safe integer");
  }
  const resourceKeys = parallelPolicy.resourceKeys;
  if (resourceKeys !== undefined) {
    if (!Array.isArray(resourceKeys) || resourceKeys.length > 32) {
      throw new WorkflowSafetyValidationError("parallelPolicy.resourceKeys must be a list of at most 32 resource keys");
    }
    const seen = new Set<string>();
    for (const key of resourceKeys) {
      if (typeof key !== "string" || key.length === 0 || key.length > 256
        || key.trim() !== key || /[\u0000-\u001f\u007f-\u009f]/u.test(key) || seen.has(key)) {
        throw new WorkflowSafetyValidationError("parallelPolicy.resourceKeys must contain unique, non-empty, trimmed keys of at most 256 characters without control characters");
      }
      seen.add(key);
    }
  }
  if (autoParallel && (sideEffectClass === "external_mutation" || sideEffectClass === "release")) {
    throw new WorkflowSafetyValidationError(`${sideEffectClass} cannot request automatic parallel execution`);
  }
  if (autoParallel && sideEffectClass === "test_artifact_only" && requiresArtifactOnly !== true) {
    throw new WorkflowSafetyValidationError("Automatic test_artifact_only execution requires parallelPolicy.requiresArtifactOnly: true");
  }
  return {
    ...safety,
    parallelPolicy: {
      autoParallel,
      ...(maxParallelSiblings === undefined ? {} : { maxParallelSiblings }),
      ...(resourceKeys === undefined ? {} : { resourceKeys: [...resourceKeys] as string[] }),
      ...(requiresArtifactOnly === undefined ? {} : { requiresArtifactOnly }),
      ...(cancelSiblingsOnFailure === undefined ? {} : { cancelSiblingsOnFailure }),
    },
  };
}
