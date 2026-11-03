import type { DelegationBudgetV1 } from "@ling-stack/contracts";

/** Pure validation errors, not persisted DelegationStep failure states. */
export type DelegationAuthorityErrorCode = `delegation.${
  "invalid_budget" | "lineage_invalid" | "deadline_exceeded" | "budget_exhausted"
  | "price_unknown" | "price_scope_conflict" | "price_invalid" | "price_overflow"}`;

export class DelegationAuthorityError extends Error {
  constructor(readonly code: DelegationAuthorityErrorCode) {
    super(code);
    this.name = "DelegationAuthorityError";
  }
}

export interface DelegationRootBudgetSnapshot {
  readonly rootRunId: string;
  readonly frozenAt: string;
  readonly deadlineAt: string;
  readonly tokenBudget?: number;
  readonly costBudgetMicros?: number;
}

export interface DelegationEffectiveBudget extends DelegationBudgetV1 {
  readonly rootRunId: string;
  readonly deadlineAt: string;
  readonly wallTimeBudgetMs: number;
}

/**
 * Resolve caps from already authenticated snapshots. This pure helper neither
 * authenticates a Host producer nor reserves capacity. The SQLite writer must
 * read those snapshots and check available capacity in its own transaction.
 */
export function resolveDelegationChildBudget(input: {
  readonly root: DelegationRootBudgetSnapshot;
  readonly parent: Omit<DelegationEffectiveBudget, "wallTimeBudgetMs"> & { readonly wallTimeBudgetMs?: number };
  readonly requested: DelegationBudgetV1;
  readonly now: string;
}): DelegationEffectiveBudget {
  const code = "delegation.invalid_budget";
  const request = record(input, ["root", "parent", "requested", "now"], code);
  const root = record(request.root, ["rootRunId", "frozenAt", "deadlineAt", "tokenBudget", "costBudgetMicros"], code);
  const parent = record(request.parent, ["rootRunId", "deadlineAt", "tokenBudget", "costBudgetMicros", "wallTimeBudgetMs"], code);
  const requested = record(request.requested, ["tokenBudget", "costBudgetMicros", "wallTimeBudgetMs"], code);
  const rootRunId = identity(root.rootRunId, code);
  if (identity(parent.rootRunId, code) !== rootRunId) fail("delegation.lineage_invalid");
  const frozenAt = timestamp(root.frozenAt, code);
  const rootDeadline = timestamp(root.deadlineAt, code);
  const parentDeadline = timestamp(parent.deadlineAt, code);
  const now = timestamp(request.now, code);
  if (rootDeadline <= frozenAt || parentDeadline <= frozenAt || now < frozenAt
    || !Number.isSafeInteger(rootDeadline - frozenAt) || !Number.isSafeInteger(parentDeadline - frozenAt)) fail(code);
  for (const snapshot of [root, parent, requested]) {
    for (const field of ["tokenBudget", "costBudgetMicros", "wallTimeBudgetMs"]) {
      if (snapshot[field] !== undefined) integer(snapshot[field], code);
    }
  }
  if (now >= rootDeadline || now >= parentDeadline) fail("delegation.deadline_exceeded");
  // Effective parent snapshots already include inheritance. Reject damaged or
  // widened persisted parents rather than silently repairing their authority.
  if (parentDeadline > rootDeadline || ["tokenBudget", "costBudgetMicros"].some(field =>
    root[field] !== undefined && (parent[field] === undefined || (parent[field] as number) > (root[field] as number)))) {
    fail("delegation.lineage_invalid");
  }
  const tokenBudget = childCap(root.tokenBudget, parent.tokenBudget, requested.tokenBudget);
  const costBudgetMicros = childCap(root.costBudgetMicros, parent.costBudgetMicros, requested.costBudgetMicros);
  // Compare durations before addition so a valid safe integer cannot overflow
  // Date's range or float precision merely by requesting a very long child.
  const remaining = Math.min(rootDeadline, parentDeadline) - now;
  const wallTimeBudgetMs = Math.min(remaining, requested.wallTimeBudgetMs as number | undefined ?? remaining);
  if (wallTimeBudgetMs <= 0) fail("delegation.deadline_exceeded");
  return Object.freeze({ rootRunId, deadlineAt: new Date(now + wallTimeBudgetMs).toISOString(),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(costBudgetMicros !== undefined ? { costBudgetMicros } : {}), wallTimeBudgetMs });
}

export interface DelegationPriceScope {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly model: string;
}

/** Host-managed versioned rate data. A valid shape alone is not Host authority. */
export interface DelegationTokenPriceSnapshot {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly currency: string;
  readonly scope: DelegationPriceScope;
  readonly inputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

export function resolveDelegationPriceForBudget(input: {
  readonly costBudgetMicros?: number;
  readonly currency: string;
  readonly scope: DelegationPriceScope;
  readonly price?: DelegationTokenPriceSnapshot;
}): DelegationTokenPriceSnapshot | undefined {
  const code = "delegation.price_invalid";
  const request = record(input, ["costBudgetMicros", "currency", "scope", "price"], code);
  if (request.costBudgetMicros !== undefined) integer(request.costBudgetMicros, "delegation.invalid_budget");
  if (request.price === undefined) {
    if (request.costBudgetMicros !== undefined) fail("delegation.price_unknown");
    return undefined;
  }
  const price = record(request.price, ["schemaVersion", "version", "currency", "scope",
    "inputMicrosPerMillionTokens", "cachedInputMicrosPerMillionTokens", "outputMicrosPerMillionTokens"], code);
  if (price.schemaVersion !== 1) fail(code);
  const version = identity(price.version, code);
  const currency = identity(price.currency, code);
  if (!/^[A-Z]{3}$/.test(currency)) fail(code);
  const scope = priceScope(price.scope);
  const expected = priceScope(request.scope);
  const expectedCurrency = identity(request.currency, code);
  if (!/^[A-Z]{3}$/.test(expectedCurrency)) fail(code);
  if (currency !== expectedCurrency || Object.keys(scope).some(key => scope[key as keyof DelegationPriceScope] !== expected[key as keyof DelegationPriceScope])) {
    fail("delegation.price_scope_conflict");
  }
  return Object.freeze({ schemaVersion: 1, version, currency, scope,
    inputMicrosPerMillionTokens: integer(price.inputMicrosPerMillionTokens, code),
    cachedInputMicrosPerMillionTokens: integer(price.cachedInputMicrosPerMillionTokens, code),
    outputMicrosPerMillionTokens: integer(price.outputMicrosPerMillionTokens, code) });
}

/** Exact conservative quote, not a transport receipt, actual bill or refund. */
export function quoteDelegationTokenCostMicros(input: {
  readonly price: DelegationTokenPriceSnapshot;
  readonly currency: string;
  readonly scope: DelegationPriceScope;
  readonly usage: { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number };
}): number {
  const code = "delegation.price_invalid";
  const request = record(input, ["price", "currency", "scope", "usage"], code);
  if (request.price === undefined) fail(code);
  const price = resolveDelegationPriceForBudget({ price: request.price as DelegationTokenPriceSnapshot,
    currency: identity(request.currency, code), scope: priceScope(request.scope) })!;
  const usage = record(request.usage, ["inputTokens", "cachedInputTokens", "outputTokens"], code);
  const inputTokens = integer(usage.inputTokens, code);
  const cachedTokens = integer(usage.cachedInputTokens, code);
  const outputTokens = integer(usage.outputTokens, code);
  if (cachedTokens > inputTokens) fail(code);
  const numerator = BigInt(inputTokens - cachedTokens) * BigInt(price.inputMicrosPerMillionTokens)
    + BigInt(cachedTokens) * BigInt(price.cachedInputMicrosPerMillionTokens)
    + BigInt(outputTokens) * BigInt(price.outputMicrosPerMillionTokens);
  const micros = (numerator + 999999n) / 1000000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) fail("delegation.price_overflow");
  return Number(micros);
}

function childCap(root: unknown, parent: unknown, requested: unknown): number | undefined {
  const caps = [root, parent].filter((value): value is number => value !== undefined);
  const cap = caps.length ? Math.min(...caps) : undefined;
  if (requested !== undefined && cap !== undefined && (requested as number) > cap) fail("delegation.budget_exhausted");
  return requested as number | undefined ?? cap;
}

function priceScope(value: unknown): DelegationPriceScope {
  const code = "delegation.price_invalid";
  const fields = record(value, ["providerId", "baseUrl", "api", "model"], code);
  return Object.freeze({ providerId: identity(fields.providerId, code), baseUrl: identity(fields.baseUrl, code),
    api: identity(fields.api, code), model: identity(fields.model, code) });
}

/** Capture data properties without invoking getters or accepting hidden fields. */
function record(value: unknown, allowed: readonly string[], code: DelegationAuthorityErrorCode): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.includes(key)) fail(code);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) fail(code);
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (error instanceof DelegationAuthorityError) throw error;
    return fail(code);
  }
}

function integer(value: unknown, code: DelegationAuthorityErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function identity(value: unknown, code: DelegationAuthorityErrorCode): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(code);
  return value;
}

function timestamp(value: unknown, code: DelegationAuthorityErrorCode): number {
  if (typeof value !== "string") fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return parsed;
}

function fail(code: DelegationAuthorityErrorCode): never {
  throw new DelegationAuthorityError(code);
}
