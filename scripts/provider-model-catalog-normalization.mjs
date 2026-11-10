const RESERVED_RUNTIME_OVERHEAD_TOKENS = 512;
const MINIMUM_INPUT_BUDGET_TOKENS = 1_024;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_OUTPUT_LIMIT_TOKENS = 16_384;

export function normalizeModelTokenLimits(limit) {
  let contextWindow = positiveInteger(limit?.context);
  const outputLimit = positiveInteger(limit?.output);
  let maxTokens = outputLimit;

  if (contextWindow === undefined && outputLimit !== undefined) {
    const fallbackSafeOutput = DEFAULT_CONTEXT_WINDOW_TOKENS
      - RESERVED_RUNTIME_OVERHEAD_TOKENS
      - MINIMUM_INPUT_BUDGET_TOKENS;
    if (outputLimit > fallbackSafeOutput) {
      maxTokens = Math.min(outputLimit, DEFAULT_OUTPUT_LIMIT_TOKENS, fallbackSafeOutput);
    }
  } else if (contextWindow !== undefined) {
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

export function normalizeThinkingModes(value) {
  if (!Array.isArray(value)) return [];
  const modes = [];
  for (const option of value) {
    if (!(option !== null && typeof option === "object" && !Array.isArray(option))) continue;
    if (option.type === "toggle") modes.push("off", "auto");
    if (option.type !== "effort") continue;
    for (const raw of (Array.isArray(option.values) ? option.values.filter((value) => typeof value === "string") : [])) {
      const mode = normalizeThinkingMode(raw);
      if (mode) modes.push(mode);
    }
  }
  const order = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  return order.filter((mode) => modes.includes(mode));
}

function normalizeThinkingMode(value) {
  const mode = value.trim().toLowerCase();
  if (mode === "none" || mode === "disabled") return "off";
  if (mode === "maximum") return "max";
  return ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(mode) ? mode : undefined;
}
