import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
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

test("background source-module suites stay in the Vite dev lane while CSS remains production-covered", () => {
  const plan = planWebSmoke({ files: ["apps/web/src/styles/theme-background.css"] });
  assert.deepEqual(plan.smoke, ["e2e/theme-full-window-p0.spec.ts"]);
  assert.deepEqual(plan.changed, ["e2e/full-window-background.spec.ts"]);
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

test("modified baseline specs retain production mode and local-only specs are reported", async () => {
  const plan = planWebSmoke({ files: ["apps/web/e2e/companions.spec.ts", "apps/web/e2e/dark-photo-visual-acceptance.spec.ts"] });
  assert.deepEqual(plan.smoke, ["e2e/companions.spec.ts"]);
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.manual, ["e2e/dark-photo-visual-acceptance.spec.ts"]);
  await assert.rejects(runWebSmoke({ ...plan, changed: ["e2e/does-not-exist.spec.ts"] }), /existing, distinct Web specs/u);
});

test("the dev tests overlap the serial production tests on a separate server and can fail the job", async t => {
  const originalPort = process.env.LING_PLAYWRIGHT_PORT;
  process.env.LING_PLAYWRIGHT_PORT = "4190";
  const launches: { child: EventEmitter, args: readonly string[], env: NodeJS.ProcessEnv }[] = [];
  const spawn = t.mock.method(childProcess, "spawn", (_command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new EventEmitter();
    launches.push({ child, args, env: options.env ?? {} });
    return child;
  });
  const mkdir = t.mock.method(fs, "mkdirSync", () => undefined);
  const write = t.mock.method(fs, "writeFileSync", () => undefined);
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    mkdir.mock.restore();
    write.mock.restore();
    syncBuiltinESMExports();
    if (originalPort === undefined) delete process.env.LING_PLAYWRIGHT_PORT;
    else process.env.LING_PLAYWRIGHT_PORT = originalPort;
  });

  const execution = runWebSmoke({ qa: ["e2e/ui2-shell-feedback-permission.spec.ts"],
    smoke: ["e2e/companions.spec.ts"], changed: ["e2e/app-shell-selectors.spec.ts"], manual: [] });
  const [qa, dev] = launches;
  assert.equal(launches.length, 2);
  assert.ok(qa && dev);
  assert.ok(qa.args.includes("--output=test-results/qa"));
  assert.ok(dev.args.includes("--output=test-results/changed"));
  assert.ok(dev.args.includes("--max-failures=1"));
  assert.equal(qa.env.LING_PLAYWRIGHT_PREVIEW, "1");
  assert.equal(qa.env.LING_PLAYWRIGHT_PORT, "4191");
  assert.equal(dev.env.LING_PLAYWRIGHT_PREVIEW, "0");
  assert.equal(dev.env.LING_PLAYWRIGHT_PORT, "4190");
  assert.equal(qa.env.LING_PLAYWRIGHT_REUSE_SERVER, "0");
  assert.equal(dev.env.LING_PLAYWRIGHT_REUSE_SERVER, "0");

  qa.child.emit("close", 0);
  dev.child.emit("close", 1);
  await setImmediate();
  const smoke = launches[2];
  assert.equal(launches.length, 3);
  assert.ok(smoke?.args.includes("--output=test-results/smoke"));
  assert.equal(smoke.env.LING_PLAYWRIGHT_PORT, qa.env.LING_PLAYWRIGHT_PORT);
  smoke.child.emit("close", 0);
  assert.equal(await execution, 1);
});
