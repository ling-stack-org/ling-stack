import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";

const scope = { providerId: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-responses", model: "fixture" };
const price = { schemaVersion: 1, version: "test-v1", currency: "USD", scope,
  inputMicrosPerMillionTokens: 10, cachedInputMicrosPerMillionTokens: 5, outputMicrosPerMillionTokens: 20 };
test("delegation startup budget and price registry are captured without invented defaults", () => {
  const input = { rootBudget: { tokenBudget: 1000, wallTimeBudgetMs: 60_000 }, currency: "USD", prices: [structuredClone(price)] };
  const config = resolveConfig({ harness: { delegations: input } });
  input.rootBudget.tokenBudget = 9999; input.prices[0].scope.model = "changed";
  assert.equal(config.harness.delegations.rootBudget.tokenBudget, 1000);
  assert.equal(config.harness.delegations.prices[0].scope.model, "fixture");
  const defaults = resolveConfig({}).harness.delegations;
  assert.equal(defaults.rootBudget, undefined); assert.equal(defaults.prices, undefined);
});
test("malformed budgets, currencies and duplicate/invalid price scopes fail closed", () => {
  for (const delegations of [{ rootBudget: { tokenBudget: -1 } }, { rootBudget: { wallTimeBudgetMs: Number.MAX_SAFE_INTEGER + 1 } },
    { currency: "usd" }, { prices: [price, structuredClone(price)] }, { prices: [{ ...price, inputMicrosPerMillionTokens: -1 }] }]) {
    assert.throws(() => resolveConfig({ harness: { delegations } }));
  }
});

test("dynamic workflows require a bounded immutable Host startup selection", () => {
  assert.deepEqual(resolveConfig({}).harness.delegations.selectedWorkflowIds, []);
  const selectedWorkflowIds = ["workflow-dedicated-qa"];
  const config = resolveConfig({ harness: { delegations: { selectedWorkflowIds } } });
  selectedWorkflowIds.push("later-selection");
  assert.deepEqual(config.harness.delegations.selectedWorkflowIds, ["workflow-dedicated-qa"]);
  assert.ok(Object.isFrozen(config.harness.delegations.selectedWorkflowIds));
  for (const value of [["one", "one"], [""], [" * "], [42], "all", Array.from({ length: 101 }, (_, i) => `workflow-${i}`)]) {
    assert.throws(() => resolveConfig({ harness: { delegations: { selectedWorkflowIds: value } } }), /workflow_selection_invalid/);
  }
});
