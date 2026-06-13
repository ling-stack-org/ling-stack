import type { ProviderModelRuntimeObservation, ProviderPreset } from "@ling-stack/core";

interface ContextLengthObservationInput {
  readonly providerPreset: ProviderPreset | undefined;
  readonly contextPack: {
    readonly estimatedInputTokens: number;
    readonly budget: {
      readonly contextWindowTokens: number;
      readonly reservedOutputTokens: number;
      readonly reservedRuntimeOverheadTokens: number;
    };
  };
  readonly now?: string;
}

const RUNTIME_OBSERVATION_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_OBSERVED_CONTEXT_WINDOW_TOKENS = 2_048;
const observedProviderContextWindows = new Map<string, ProviderModelRuntimeObservation>();

export function providerRuntimeObservationForPreset(
  providerPreset: ProviderPreset | undefined,
  now: Date = new Date(),
): ProviderModelRuntimeObservation | undefined {
  if (!providerPreset) {
    return undefined;
  }
  const key = providerRuntimeObservationKey(providerPreset);
  const observation = observedProviderContextWindows.get(key);
  if (!observation) {
    return undefined;
  }
  if (now.getTime() - Date.parse(observation.observedAt) > RUNTIME_OBSERVATION_TTL_MS) {
    observedProviderContextWindows.delete(key);
    return undefined;
  }
  return observation;
}

export function recordProviderContextLengthObservation(input: ContextLengthObservationInput): ProviderModelRuntimeObservation | undefined {
  if (!input.providerPreset) {
    return undefined;
  }
  const previousContextWindowTokens = positiveInteger(input.contextPack.budget.contextWindowTokens);
  if (!previousContextWindowTokens) {
    return undefined;
  }
  const attemptedContextWindowTokens =
    input.contextPack.estimatedInputTokens +
    input.contextPack.budget.reservedOutputTokens +
    input.contextPack.budget.reservedRuntimeOverheadTokens;
  const observedContextWindowTokens = downgradeContextWindow(previousContextWindowTokens, attemptedContextWindowTokens);
  if (observedContextWindowTokens >= previousContextWindowTokens) {
    return undefined;
  }

  const key = providerRuntimeObservationKey(input.providerPreset);
  const previousObservation = observedProviderContextWindows.get(key);
  if (previousObservation && previousObservation.observedContextWindowTokens <= observedContextWindowTokens) {
    return previousObservation;
  }

  const observedAt = input.now ?? new Date().toISOString();
  const observation: ProviderModelRuntimeObservation = {
    providerPresetId: input.providerPreset.id,
    providerKind: input.providerPreset.kind,
    providerApi: input.providerPreset.api,
    modelId: input.providerPreset.model,
    previousContextWindowTokens,
    observedContextWindowTokens,
    failureCode: "context_length_error",
    observedAt,
  };
  observedProviderContextWindows.set(key, observation);
  return observation;
}

function providerRuntimeObservationKey(providerPreset: ProviderPreset): string {
  return [
    providerPreset.id,
    providerPreset.kind,
    providerPreset.api,
    providerPreset.model,
  ].join(":");
}

function downgradeContextWindow(previousContextWindowTokens: number, attemptedContextWindowTokens: number): number {
  const attemptedCap = Math.floor(Math.max(0, attemptedContextWindowTokens) * 0.75);
  const previousCap = Math.floor(previousContextWindowTokens * 0.75);
  const candidate = attemptedCap > 0 ? Math.min(attemptedCap, previousCap) : previousCap;
  return Math.max(MIN_OBSERVED_CONTEXT_WINDOW_TOKENS, candidate);
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
