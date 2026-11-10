import assert from "node:assert/strict";
import test from "node:test";

import {
  draftNamespacePrefix,
  removeConversationDraftsFromStorage,
} from "../src/platform/conversation-draft-cleanup.ts";

function createStorage(entries = []) {
  const values = new Map(entries);
  const removalCalls = [];
  let enumerationCalls = 0;
  return {
    values,
    removalCalls,
    get enumerationCalls() { return enumerationCalls; },
    async getAllKeys() {
      enumerationCalls += 1;
      return Object.freeze([...values.keys()]);
    },
    async multiRemove(keys) {
      removalCalls.push([...keys]);
      for (const key of keys) {
        values.delete(key);
      }
    },
  };
}

test("AsyncStorage 2.x cleanup batches only the requested binding's drafts", async () => {
  const binding = "workspace_binding_91ec4074-33d0-4fc4-a231-2637bc6d2c14";
  const prefix = draftNamespacePrefix(binding);
  const selectedKeys = [`${prefix}conversation_1`, `${prefix}conversation_2`];
  const unrelatedKeys = [
    `${draftNamespacePrefix(`${binding}_other`)}conversation_1`,
    `${draftNamespacePrefix("workspace_binding_other")}conversation_1`,
    `ling.remote.cache.v1.${binding}`,
    "ling.mobile.theme.v1",
  ];
  const storage = createStorage([...selectedKeys, ...unrelatedKeys].map((key) => [key, "saved"]));

  await removeConversationDraftsFromStorage(storage, binding);

  assert.equal(storage.enumerationCalls, 1);
  assert.deepEqual(storage.removalCalls, [selectedKeys]);
  assert.deepEqual([...storage.values.keys()], unrelatedKeys);
});

test("draft cleanup keeps the existing URI-encoded binding namespace", async () => {
  const binding = "workspace_binding:phone";
  assert.equal(draftNamespacePrefix(binding), "ling.mobile.draft.v1.workspace_binding%3Aphone.");
  const key = `${draftNamespacePrefix(binding)}conversation_1`;
  const storage = createStorage([[key, "saved"]]);

  await removeConversationDraftsFromStorage(storage, binding);

  assert.deepEqual(storage.removalCalls, [[key]]);
  assert.equal(storage.values.size, 0);
});

test("empty storage does not call multiRemove", async () => {
  const storage = createStorage();

  await removeConversationDraftsFromStorage(storage, "workspace_binding_1");

  assert.equal(storage.enumerationCalls, 1);
  assert.deepEqual(storage.removalCalls, []);
});

test("a namespace without drafts leaves other stored data untouched", async () => {
  const entries = [["ling.mobile.theme.v1", "dark"], ["ling.mobile.draft.v1.workspace_binding_2.conversation_1", "saved"]];
  const storage = createStorage(entries);

  await removeConversationDraftsFromStorage(storage, "workspace_binding_1");

  assert.deepEqual([...storage.values.entries()], entries);
  assert.deepEqual(storage.removalCalls, []);
});

test("enumeration failure propagates without deleting or retrying", async () => {
  const error = new Error("native storage enumeration failed");
  const storage = createStorage();
  let attempts = 0;
  storage.getAllKeys = async () => {
    attempts += 1;
    throw error;
  };

  await assert.rejects(() => removeConversationDraftsFromStorage(storage, "workspace_binding_1"), (actual) => actual === error);

  assert.equal(attempts, 1);
  assert.deepEqual(storage.removalCalls, []);
});

test("multiRemove failure propagates without retrying or claiming cleanup succeeded", async () => {
  const key = `${draftNamespacePrefix("workspace_binding_1")}conversation_1`;
  const error = new Error("native storage deletion failed");
  const storage = createStorage([[key, "saved"]]);
  let attempts = 0;
  storage.multiRemove = async (keys) => {
    attempts += 1;
    assert.deepEqual(keys, [key]);
    throw error;
  };

  await assert.rejects(() => removeConversationDraftsFromStorage(storage, "workspace_binding_1"), (actual) => actual === error);

  assert.equal(attempts, 1);
  assert.equal(storage.values.get(key), "saved");
});
