import { resolveDelegationPriceForBudget, type DelegationPriceScope, type DelegationTokenPriceSnapshot } from "@ling-stack/core";

/**
 * Immutable Host configuration. No guessed default prices: an unlisted scope
 * remains usable without a monetary cap, and cost-mode admission fails closed.
 */
export function createDelegationPriceRegistry(entries: readonly DelegationTokenPriceSnapshot[]): {
  readonly lookup: (scope: DelegationPriceScope, currency: string) => DelegationTokenPriceSnapshot | undefined;
} {
  const prices = new Map<string, DelegationTokenPriceSnapshot>();
  const key = (scope: DelegationPriceScope, currency: string): string => JSON.stringify([currency, scope.providerId, scope.baseUrl, scope.api, scope.model]);
  for (const entry of entries) {
    const price = resolveDelegationPriceForBudget({ price: entry, currency: entry.currency, scope: entry.scope })!;
    const identity = key(price.scope, price.currency);
    if (prices.has(identity)) throw new Error("delegation.price_registry_scope_duplicate");
    prices.set(identity, price);
  }
  return Object.freeze({ lookup: (scope: DelegationPriceScope, currency: string) => {
    const price = prices.get(key(scope, currency));
    return resolveDelegationPriceForBudget({ scope, currency, ...(price ? { price } : {}) });
  } });
}
