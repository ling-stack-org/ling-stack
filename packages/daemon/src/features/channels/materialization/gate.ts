import type { LingMaterializationStatus } from "@ling-stack/core";

export interface LingMaterializationGateInput {
  readonly requiredStatuses: readonly LingMaterializationStatus[];
}

export interface LingMaterializationGateResult {
  readonly mayAnswer: boolean;
  readonly mayAutoStart: boolean;
  readonly missingRequiredInput: boolean;
  readonly blockedRequiredInput: boolean;
}

export function evaluateMaterializationGate(input: LingMaterializationGateInput): LingMaterializationGateResult {
  const missingRequiredInput = input.requiredStatuses.some((status) => status === "metadata_only" || status === "not_loaded" || status === "unsupported");
  const blockedRequiredInput = input.requiredStatuses.some((status) => status === "blocked");
  return {
    mayAnswer: !missingRequiredInput && !blockedRequiredInput,
    mayAutoStart: !missingRequiredInput && !blockedRequiredInput,
    missingRequiredInput,
    blockedRequiredInput,
  };
}
