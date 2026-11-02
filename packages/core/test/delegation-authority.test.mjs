import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../dist/index.js";

const now = "2026-10-19T01:00:10.000Z";
const root = Object.freeze({ rootRunId: "root", frozenAt: "2026-10-19T01:00:00.000Z",
  deadlineAt: "2026-10-19T02:00:00.000Z", tokenBudget: 1000, costBudgetMicros: 5000 });
const parent = Object.freeze({ rootRunId: "root", deadlineAt: "2026-10-19T01:30:00.000Z", tokenBudget: 400, costBudgetMicros: 2000 });
const scope = Object.freeze({ providerId: "relay", baseUrl: "https://example.invalid/v1", api: "openai-completions", model: "fixture-model" });
const price = Object.freeze({ schemaVersion: 1, version: "host-price-1", currency: "USD", scope,
  inputMicrosPerMillionTokens: 1500000, cachedInputMicrosPerMillionTokens: 300000, outputMicrosPerMillionTokens: 6000000 });

function resolve(changes = {}) {
  assert.equal(typeof core.resolveDelegationChildBudget, "function", "H10 pure budget resolver must exist");
  return core.resolveDelegationChildBudget({ root, parent, requested: {}, now, ...changes });
}
function resolvePrice(changes = {}) {
  assert.equal(typeof core.resolveDelegationPriceForBudget, "function", "H10 scoped price resolver must exist");
  return core.resolveDelegationPriceForBudget({ costBudgetMicros: 1000, currency: "USD", scope, price, ...changes });
}
function quote(usage, changes = {}) {
  assert.equal(typeof core.quoteDelegationTokenCostMicros, "function", "H10 integer price quote must exist");
  return core.quoteDelegationTokenCostMicros({ price, currency: "USD", scope, usage, ...changes });
}
function rejected(action, code) {
  assert.throws(action, error => error?.code === code);
}

test("H10 child inherits root/parent caps without mutating either snapshot", () => {
  const budget = resolve();
  assert.deepEqual(budget, { rootRunId: root.rootRunId, deadlineAt: parent.deadlineAt,
    tokenBudget: 400, costBudgetMicros: 2000, wallTimeBudgetMs: 1790000 });
  assert.equal(Object.isFrozen(budget), true);
  assert.equal(root.tokenBudget, 1000);
  assert.equal(parent.tokenBudget, 400);
});

test("H10 incomplete or widened effective parent cannot be hidden by root clamping", () => {
  for (const widened of [
    { ...parent, tokenBudget: undefined }, { ...parent, tokenBudget: 1001 },
    { ...parent, costBudgetMicros: undefined }, { ...parent, costBudgetMicros: 5001 },
    { ...parent, deadlineAt: "2026-10-20T00:00:00.000Z" },
  ]) rejected(() => resolve({ parent: widened }), "delegation.lineage_invalid");
  const uncapped = resolve({ root: { rootRunId: "root", frozenAt: root.frozenAt, deadlineAt: root.deadlineAt },
    parent: { rootRunId: "root", deadlineAt: parent.deadlineAt } });
  assert.equal(uncapped.tokenBudget, undefined);
});

test("H10 explicit child caps may narrow but never exceed parent or root", () => {
  assert.equal(resolve({ requested: { tokenBudget: 200, costBudgetMicros: 1000 } }).tokenBudget, 200);
  rejected(() => resolve({ requested: { tokenBudget: 401 } }), "delegation.budget_exhausted");
  rejected(() => resolve({ requested: { costBudgetMicros: 2001 } }), "delegation.budget_exhausted");
});

test("H10 child duration narrows absolute deadline and later recovery never resets it", () => {
  const child = resolve({ requested: { wallTimeBudgetMs: 1000 } });
  assert.equal(child.deadlineAt, "2026-10-19T01:00:11.000Z");
  const grandchild = resolve({ parent: child, now: "2026-10-19T01:00:10.900Z", requested: { wallTimeBudgetMs: 1000 } });
  assert.equal(grandchild.deadlineAt, child.deadlineAt);
  assert.equal(grandchild.wallTimeBudgetMs, 100);
  rejected(() => resolve({ parent: child, now: child.deadlineAt }), "delegation.deadline_exceeded");
});

test("H10 expired root refuses regardless of a later parent deadline", () => {
  rejected(() => resolve({ now: root.deadlineAt, parent: { ...parent, deadlineAt: "2026-10-20T00:00:00.000Z" } }), "delegation.deadline_exceeded");
});

test("H10 rejects wrong root, invalid clock and malformed snapshots", () => {
  rejected(() => resolve({ parent: { ...parent, rootRunId: "foreign" } }), "delegation.lineage_invalid");
  for (const invalidNow of ["not-a-time", "2026-10-19", "2026-10-19T00:59:59.999Z"]) {
    rejected(() => resolve({ now: invalidNow }), "delegation.invalid_budget");
  }
  rejected(() => resolve({ root: { ...root, deadlineAt: root.frozenAt } }), "delegation.invalid_budget");
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(() => resolve({ requested: { tokenBudget: value } }), "delegation.invalid_budget");
    rejected(() => resolve({ parent: { ...parent, costBudgetMicros: value } }), "delegation.invalid_budget");
  }
});

test("H10 zero caps are real caps, not a missing/unlimited budget", () => {
  const budget = resolve({ requested: { tokenBudget: 0, costBudgetMicros: 0 } });
  assert.equal(budget.tokenBudget, 0);
  assert.equal(budget.costBudgetMicros, 0);
  rejected(() => resolve({ requested: { wallTimeBudgetMs: 0 } }), "delegation.deadline_exceeded");
});

test("H10 unknown price refuses monetary spawn only, including zero monetary cap", () => {
  rejected(() => resolvePrice({ price: undefined }), "delegation.price_unknown");
  rejected(() => resolvePrice({ price: undefined, costBudgetMicros: 0 }), "delegation.price_unknown");
  assert.equal(resolvePrice({ price: undefined, costBudgetMicros: undefined }), undefined);
});

test("H10 price version, currency and exact provider route are mandatory", () => {
  assert.deepEqual(resolvePrice(), price);
  for (const key of Object.keys(scope)) {
    rejected(() => resolvePrice({ scope: { ...scope, [key]: "different" } }), "delegation.price_scope_conflict");
  }
  rejected(() => resolvePrice({ currency: "EUR" }), "delegation.price_scope_conflict");
  rejected(() => resolvePrice({ price: { ...price, version: "" } }), "delegation.price_invalid");
  rejected(() => resolvePrice({ price: { ...price, schemaVersion: 2 } }), "delegation.price_invalid");
});

test("H10 price quote uses normal/cached/output token buckets and rounds up once", () => {
  assert.equal(quote({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 }), 21);
  assert.equal(quote({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }), 2);
  assert.equal(quote({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), 0);
});

test("H10 quote retains exact safe-integer precision with BigInt intermediates", () => {
  const large = { ...price, inputMicrosPerMillionTokens: 1000000 };
  assert.equal(quote({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0 }, { price: large }), Number.MAX_SAFE_INTEGER);
  rejected(() => quote({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 0 }), "delegation.price_overflow");
});

test("H10 invalid usage, missing cached price and unsafe rates fail without estimates", () => {
  rejected(() => quote({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 }), "delegation.price_invalid");
  rejected(() => quote({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }), "delegation.price_invalid");
  for (const rate of [undefined, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(() => resolvePrice({ price: { ...price, cachedInputMicrosPerMillionTokens: rate } }), "delegation.price_invalid");
  }
});

test("H10 outer accessors never execute or bypass unknown-price rejection", () => {
  let calls = 0;
  const input = { currency: "USD", scope, price: undefined };
  Object.defineProperty(input, "costBudgetMicros", { enumerable: true, get() { return ++calls === 1 ? 1000 : undefined; } });
  rejected(() => core.resolveDelegationPriceForBudget(input), "delegation.price_invalid");
  assert.equal(calls, 0);
  const budget = { parent, requested: {}, now };
  Object.defineProperty(budget, "root", { enumerable: true, get() { calls++; throw new Error("must not escape"); } });
  rejected(() => core.resolveDelegationChildBudget(budget), "delegation.invalid_budget");
  assert.equal(calls, 0);
  const cost = { price, currency: "USD", scope };
  Object.defineProperty(cost, "usage", { enumerable: true, get() { calls++; throw new Error("must not escape"); } });
  rejected(() => core.quoteDelegationTokenCostMicros(cost), "delegation.price_invalid");
  assert.equal(calls, 0);
});

test("H10 outer extra/symbol fields and revoked proxies return typed errors", () => {
  rejected(() => resolve({ extra: true }), "delegation.invalid_budget");
  rejected(() => resolvePrice({ [Symbol("hidden")]: true }), "delegation.price_invalid");
  rejected(() => quote({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, { extra: true }), "delegation.price_invalid");
  for (const [fn, code] of [[core.resolveDelegationChildBudget, "delegation.invalid_budget"],
    [core.resolveDelegationPriceForBudget, "delegation.price_invalid"], [core.quoteDelegationTokenCostMicros, "delegation.price_invalid"]]) {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    rejected(() => fn(proxy), code);
  }
});

test("H10 canonical Date endpoints cannot produce an unsafe duration", () => {
  const wideRoot = { rootRunId: "root", frozenAt: "-271821-04-20T00:00:00.000Z", deadlineAt: "+275760-09-13T00:00:00.000Z" };
  rejected(() => resolve({ root: wideRoot, parent: { rootRunId: "root", deadlineAt: wideRoot.deadlineAt }, now: wideRoot.frozenAt }), "delegation.invalid_budget");
});
