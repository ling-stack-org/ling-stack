const RESERVED_RUNTIME_OVERHEAD_TOKENS = 512;
const MINIMUM_INPUT_BUDGET_TOKENS = 1_024;
const DEFAULT_OUTPUT_LIMIT_TOKENS = 16_384;

export function normalizeModelTokenLimits(limit) {
  let contextWindow = positiveInteger(limit?.context);
  const outputLimit = positiveInteger(limit?.output);
  let maxTokens = outputLimit;

  if (contextWindow !== undefined) {
    const largestSafeOutput = contextWindow - RESERVED_RUNTIME_OVERHEAD_TOKENS - MINIMUM_INPUT_BUDGET_TOKENS;
    if (largestSafeOutput <= 0) {
      contextWindow = undefined;
      maxTokens = undefined;
    } else if (outputLimit === undefined) {
      maxTokens = DEFAULT_OUTPUT_LIMIT_TOKENS > largestSafeOutput ? largestSafeOutput : undefined;
    } else if (outputLimit > largestSafeOutput) {
      maxTokens = Math.min(outputLimit, DEFAULT_OUTPUT_LIMIT_TOKENS, largestSafeOutput);
    }
  }

  return { contextWindow, maxTokens };
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
