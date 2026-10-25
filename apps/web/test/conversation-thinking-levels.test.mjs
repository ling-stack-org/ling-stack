import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

async function load(path) {
  const code = stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), "utf8"), { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { normalConversationThinkingOptions: options, normalConversationDefaultThinkingLevel: defaultLevel,
  normalConversationThinkingLabel: label } = await load("../src/features/workspace/normal-conversation-composer-options.ts");
const { upsertLocalConversationRecord } = await load("../src/app/local-conversation-records.ts");

test("slider follows advertised levels and retains the native max and ultra labels", () => {
  assert.deepEqual(options(["ultra", "low", "max", "high"]), ["low", "high", "max", "ultra"]);
  assert.deepEqual(options([]), []);
  assert.deepEqual(options(["off"]), []);
  assert.equal(defaultLevel(["low", "medium", "high", "max"]), "medium");
  assert.equal(defaultLevel(["low", "high"]), "low");
  assert.equal(defaultLevel(["off", "high"]), "off");
  assert.equal(label("max", value => value), "Max");
  assert.equal(label("ultra", value => value), "Ultra");
});

test("local conversation records preserve max and ultra across draft updates", () => {
  for (const thinkingLevel of ["max", "ultra"]) {
    const { records } = upsertLocalConversationRecord([], "A request", "", {}, { providerPresetId: "relay", thinkingLevel });
    assert.equal(records[0].thinkingLevel, thinkingLevel);
    const updated = upsertLocalConversationRecord(records, "Another request", records[0].id, {}, { providerPresetId: "relay", thinkingLevel });
    assert.equal(updated.records[0].thinkingLevel, thinkingLevel);
  }
});
