import { estimateTextTokens, type ContextBudget } from "./context-packs.js";

export type ChannelReplyBudgetAdmission =
  | { readonly status: "admitted"; readonly estimatedInputTokens: number }
  | {
      readonly status: "blocked";
      readonly reason: "capacity_unknown" | "prepared_input_exceeded";
      readonly estimatedInputTokens: number;
    };

/** Check the actual no-tool reply input after summary, web evidence and memory have been rendered. */
export function assessChannelReplyBudget(input: {
  readonly budget: ContextBudget;
  readonly contextPackOverBudget: boolean;
  readonly systemPrompt: string;
  readonly prompt: string;
}): ChannelReplyBudgetAdmission {
  const estimatedInputTokens = estimateTextTokens(input.systemPrompt) + estimateTextTokens(input.prompt);
  if (!Number.isSafeInteger(input.budget.inputBudgetTokens) || input.budget.inputBudgetTokens < 1) {
    return { status: "blocked", reason: "capacity_unknown", estimatedInputTokens };
  }
  if (input.contextPackOverBudget || estimatedInputTokens > input.budget.inputBudgetTokens) {
    return { status: "blocked", reason: "prepared_input_exceeded", estimatedInputTokens };
  }
  // A custom compatible provider may not report its true window. Its Host-owned
  // conservative fallback remains an operational ceiling, not a capacity claim.
  return { status: "admitted", estimatedInputTokens };
}
