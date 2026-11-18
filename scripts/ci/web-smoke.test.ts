import assert from "node:assert/strict";
import test from "node:test";
import { planWebSmoke, runWebSmoke } from "./web-smoke.mjs";

test("mapped Web features select their browser suites and changed specs without duplicates", () => {
  const plan = planWebSmoke({ files: [
    "apps/web/src/features/plugins/PluginManagerTable.tsx",
    "apps/web/e2e/ui2-plugin-manager.spec.ts",
    "apps/web/src/shared/conversation/change-summary/ConversationChangeSummary.tsx",
    "apps/web/e2e/app-shell-selectors.spec.ts",
  ] });
  assert.deepEqual(plan.qa, []);
  assert.deepEqual(plan.smoke, ["e2e/conversation-change-summary.spec.ts", "e2e/plugins.spec.ts", "e2e/ui2-plugin-manager.spec.ts"]);
  assert.deepEqual(plan.changed, ["e2e/app-shell-selectors.spec.ts"]);
});

test("shared Web inputs, deleted specs, and full CI retain the common QA and baseline tests", () => {
  for (const plan of [
    planWebSmoke({ files: ["apps/web/src/app/AppShell.tsx"] }),
    planWebSmoke({ files: ["packages/ui-react/src/index.ts"] }),
    planWebSmoke({ files: ["apps/web/e2e/removed.spec.ts"] }),
    planWebSmoke({ files: ["apps/web/src/features/companions/CompanionMiniPanel.tsx"], full: true }),
  ]) {
    assert.equal(plan.qa.length, 4);
    assert.deepEqual(plan.smoke, ["e2e/companions.spec.ts", "e2e/conversation-change-summary.spec.ts"]);
  }
});

test("modified baseline specs retain production mode and local-only specs are reported", () => {
  const plan = planWebSmoke({ files: ["apps/web/e2e/companions.spec.ts", "apps/web/e2e/dark-photo-visual-acceptance.spec.ts"] });
  assert.deepEqual(plan.smoke, ["e2e/companions.spec.ts"]);
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.manual, ["e2e/dark-photo-visual-acceptance.spec.ts"]);
  assert.throws(() => runWebSmoke({ ...plan, changed: ["e2e/does-not-exist.spec.ts"] }), /existing, distinct Web specs/u);
});
