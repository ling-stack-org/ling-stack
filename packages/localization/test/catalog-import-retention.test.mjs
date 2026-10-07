import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assertCatalogImportRetainsMessages } from "../scripts/catalog-utils.mjs";

test("legacy imports reject dropped source keys instead of silently deleting runtime messages", () => {
  assert.throws(() => assertCatalogImportRetainsMessages({ kept: "Kept", runtime: "Checking status" }, { kept: "Kept" }), /would drop 1 source messages: runtime/);
  assert.doesNotThrow(() => assertCatalogImportRetainsMessages({ kept: "Old" }, { kept: "New", added: "Added" }));
});

test("workflow runtime narration remains in both additional import sources", () => {
  const suffixes = ["blocked_state", "checking", "completed", "failed_state", "idle", "not_started", "queued", "runs_cancelled", "runs_completed", "runs_failed", "runs_waiting", "started", "unverified", "waiting_for_approval"];
  for (const name of ["additional-source", "additional-zh-CN"]) {
    const messages = JSON.parse(fs.readFileSync(new URL(`../catalogs/${name}.json`, import.meta.url), "utf8"));
    for (const suffix of suffixes) assert.ok(messages[`daemon.channel.workflow_start.${suffix}`]?.trim(), `${name}: ${suffix}`);
  }
});
