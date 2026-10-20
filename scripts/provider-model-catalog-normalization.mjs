const RESERVED_RUNTIME_OVERHEAD_TOKENS = 512;

export function normalizeModelTokenLimits(limit) {
  const contextWindow = positiveInteger(limit?.context);
  const outputLimit = positiveInteger(limit?.output);
  const maxTokens = contextWindow !== undefined && outputLimit !== undefined
    && outputLimit + RESERVED_RUNTIME_OVERHEAD_TOKENS >= contextWindow
    ? undefined
    : outputLimit;

  return { contextWindow, maxTokens };
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
