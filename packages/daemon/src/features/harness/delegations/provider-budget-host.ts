import { quoteDelegationTokenCostMicros, type RunSession, type RunStore, type WorkUnitAttempt } from "@ling-stack/core";
import type { PiRunnerProviderBudgetPort, PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { captureOriginalDelegationProviderBinding } from "./store-composition.js";

/** Exact original Provider + Attempt only; observers/context estimates are never used as this gate. */
export function bindOriginalDelegationProviderBudget(input: {
  readonly store: RunStore; readonly run: RunSession; readonly attempt: WorkUnitAttempt;
  readonly originalProvider: PiRunnerProviderConfig; readonly now?: () => string;
}): PiRunnerProviderBudgetPort | undefined {
  const binding = captureOriginalDelegationProviderBinding(input);
  if (!binding) return undefined;
  const now = input.now ?? (() => new Date().toISOString());
  const invocations = new Map<string, { readonly chargeId: string; settled: boolean }>();
  let unresolved = false;
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  function owned(receipt: { readonly invocationId: string; readonly reservationId: string; readonly runId: string; readonly attemptId: string;
    readonly provider: string; readonly model: string; readonly api: string }) {
    if (receipt.runId !== input.run.id || receipt.attemptId !== input.attempt.id || receipt.provider !== input.originalProvider.provider
      || receipt.model !== input.originalProvider.model || receipt.api !== input.originalProvider.api) fail("delegation.invocation_identity_invalid");
    const invocation = invocations.get(receipt.invocationId);
    if (!invocation || invocation.chargeId !== receipt.reservationId || invocation.settled) fail("delegation.invocation_identity_invalid");
    return invocation!;
  }
  return Object.freeze({
    requiresTokenUpperBound: binding.root.tokenBudget !== undefined,
    requiresCostUpperBound: binding.root.costBudgetMicros !== undefined,
    reserve(request) {
      if (unresolved) fail("delegation.usage_unknown");
      if (request.runId !== input.run.id || request.attemptId !== input.attempt.id || request.provider !== input.originalProvider.provider
        || request.model !== input.originalProvider.model || request.api !== input.originalProvider.api
        || invocations.has(request.invocationId)) fail("delegation.invocation_identity_invalid");
      if (!positive(request.contextWindowTokens) || !positive(request.maxOutputTokens)
        || !Number.isSafeInteger(request.contextWindowTokens + request.maxOutputTokens)) fail("delegation.invocation_bound_unavailable");
      // The original adapter verifies the resolved model/credential tuple and
      // wire max-output before reaching here. Reserve its full model context,
      // never an optimistic context projection or the UI token estimate.
      const tokens = request.contextWindowTokens + request.maxOutputTokens;
      const price = binding.price;
      const cost = price === undefined ? undefined : quoteDelegationTokenCostMicros({ price, currency: price.currency, scope: price.scope,
        usage: { inputTokens: request.contextWindowTokens,
          cachedInputTokens: price.cachedInputMicrosPerMillionTokens > price.inputMicrosPerMillionTokens ? request.contextWindowTokens : 0,
          outputTokens: request.maxOutputTokens } });
      try {
        const charge = binding.reserve(request.invocationId, tokens, cost, now());
        invocations.set(request.invocationId, { chargeId: charge.id, settled: false });
        return Object.freeze({ reservationId: charge.id, reservedTokens: tokens, ...(cost === undefined ? {} : { reservedCostMicros: cost }) });
      } catch (error) { unresolved = true; throw error; }
    },
    settle(receipt) {
      const invocation = owned(receipt), usage = receipt.usage;
      const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      if (![usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.totalTokens].every(nonnegative)
        || !Number.isSafeInteger(total) || total < 1 || total !== usage.totalTokens
        || binding.price !== undefined && usage.cacheWrite > 0) {
        unresolved = true;
        binding.settle(invocation.chargeId, { kind: "unknown" }, receipt.invocationId, now());
        invocation.settled = true;
        return;
      }
      try {
        binding.settle(invocation.chargeId, { kind: "measured", inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
          cachedInputTokens: usage.cacheRead, outputTokens: usage.output }, receipt.invocationId, now());
        invocation.settled = true;
      } catch (error) { unresolved = true; throw error; }
    },
    settleUnknown(receipt) {
      const invocation = owned(receipt);
      unresolved = true;
      binding.settle(invocation.chargeId, { kind: "unknown" }, receipt.invocationId, now());
      invocation.settled = true;
    },
  } satisfies PiRunnerProviderBudgetPort);
}
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positive(value: unknown): value is number { return nonnegative(value) && value > 0; }
