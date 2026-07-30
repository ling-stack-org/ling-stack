import assert from "node:assert/strict";
import test from "node:test";
import { PluginActionRequestFence, pluginActionKey } from "../src/domains/plugins/plugin-action-fence.ts";

test("Computer Control On-Off-On shares one activation family and rejects out-of-order completions", () => {
  const fence = new PluginActionRequestFence();
  const on1 = action("enable", "on-1");
  const off = action("disable", "off-2");
  const on3 = action("enable", "on-3");

  assert.equal(pluginActionKey(on1), pluginActionKey(off));
  assert.equal(pluginActionKey(off), pluginActionKey(on3));
  fence.begin(on1);
  fence.begin(off);
  fence.begin(on3);

  assert.equal(fence.isLatest(off), false, "late disable cannot overwrite the final On intent");
  assert.equal(fence.isLatest(on1), false, "old enable cannot overwrite the final On response");
  assert.equal(fence.isLatest(on3), true);
  fence.finish(off);
  assert.equal(fence.isLatest(on3), true, "stale completion cannot clear current pending state");
  fence.finish(on3);
  assert.equal(fence.isLatest(on3), false);
});

test("ordinary Plugin Manager actions retain their action-specific request keys", () => {
  assert.notEqual(
    pluginActionKey({ ...action("enable", "a"), owner: "row" }),
    pluginActionKey({ ...action("disable", "b"), owner: "row" }),
  );
});

function action(actionName, requestId) {
  return {
    pluginId: "trusted-local:cua-driver",
    action: actionName,
    owner: "computer-control",
    requestId,
  };
}
