import { estimateTextTokens, type ContextBudget } from "./context-packs.js";

export type ChannelReplyBudgetAdmission =
  | { readonly status: "admitted"; readonly estimatedInputTokens: number }
  | {
      readonly status: "blocked";
      readonly reason: "capacity_unknown" | "output_reservation_exhausted" | "prepared_input_exceeded";
      readonly estimatedInputTokens: number;
    };

export class ChannelModelBudgetError extends Error {
  constructor(readonly reason: Extract<ChannelReplyBudgetAdmission, { status: "blocked" }>["reason"]) {
    super(`Channel model input blocked: ${reason}.`);
    this.name = "ChannelModelBudgetError";
  }
}

export function requireChannelNoToolsBudget(input: Parameters<typeof assessChannelReplyBudget>[0]): void {
  const admission = assessChannelReplyBudget(input);
  if (admission.status === "blocked") throw new ChannelModelBudgetError(admission.reason);
}

/** Check actual no-tool input after all context and system instructions have been rendered. */
export function assessChannelReplyBudget(input: {
  readonly budget: ContextBudget;
  readonly contextPackOverBudget: boolean;
  readonly systemPrompt: string;
  readonly prompt: string;
}): ChannelReplyBudgetAdmission {
  const estimatedInputTokens = estimateTextTokens(input.systemPrompt) + estimateTextTokens(input.prompt);
  const budget = input.budget;
  if (!Number.isSafeInteger(budget.contextWindowTokens) || budget.contextWindowTokens < 1
    || !Number.isSafeInteger(budget.reservedOutputTokens) || budget.reservedOutputTokens < 1
    || !Number.isSafeInteger(budget.reservedRuntimeOverheadTokens) || budget.reservedRuntimeOverheadTokens < 0) {
    return { status: "blocked", reason: "capacity_unknown", estimatedInputTokens };
  }
  const availableInputTokens = budget.contextWindowTokens - budget.reservedOutputTokens - budget.reservedRuntimeOverheadTokens;
  if (availableInputTokens < 1) {
    return { status: "blocked", reason: "output_reservation_exhausted", estimatedInputTokens };
  }
  if (!Number.isSafeInteger(budget.inputBudgetTokens) || budget.inputBudgetTokens < 1
    || budget.inputBudgetTokens > availableInputTokens) {
    return { status: "blocked", reason: "capacity_unknown", estimatedInputTokens };
  }
  if (input.contextPackOverBudget || estimatedInputTokens > input.budget.inputBudgetTokens) {
    return { status: "blocked", reason: "prepared_input_exceeded", estimatedInputTokens };
  }
  // A custom compatible provider may not report its true window. Its Host-owned
  // conservative fallback remains an operational ceiling, not a capacity claim.
  return { status: "admitted", estimatedInputTokens };
}
