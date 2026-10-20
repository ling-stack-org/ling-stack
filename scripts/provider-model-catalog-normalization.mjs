const RESERVED_RUNTIME_OVERHEAD_TOKENS = 512;

export function normalizeModelTokenLimits(limit) {
  let contextWindow = positiveInteger(limit?.context);
  const outputLimit = positiveInteger(limit?.output);
  let maxTokens = outputLimit;

  if (contextWindow !== undefined && outputLimit !== undefined
    && outputLimit + RESERVED_RUNTIME_OVERHEAD_TOKENS >= contextWindow) {
    const largestSafeOutput = contextWindow - RESERVED_RUNTIME_OVERHEAD_TOKENS - 1;
    if (largestSafeOutput > 0) {
      maxTokens = Math.min(outputLimit, largestSafeOutput);
    } else {
      contextWindow = undefined;
      maxTokens = undefined;
    }
  }

  return { contextWindow, maxTokens };
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
