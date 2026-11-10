import assert from "node:assert/strict";
import test from "node:test";

import {
  fullAccessConfirmationScopeKey,
  fullAccessConfirmationScopeStorageId,
  fullAccessPolicyRevision,
  channelFullAccessScope,
  fullAccessRunScope,
} from "../src/app/full-access-confirmation-scopes.ts";
import {
  loadFullAccessConfirmations,
  persistFullAccessConfirmations,
  rememberFullAccessConfirmation,
} from "../src/app/full-access-confirmation-storage.ts";

test("channel confirmation belongs to the canonical thread and workspace, including default", () => {
  const input = { channel: { boundPath: "/shared/execution" }, channelId: "channel", branchId: "branch",
    workspaceCwd: "/workspace", policyRevision: "policy", threadId: "thread-a" };
  const key = (change = {}) => fullAccessConfirmationScopeKey(channelFullAccessScope({ ...input, ...change }));
  assert.equal(key(), key({ branchId: "legacy-renamed" }));
  assert.notEqual(key(), key({ threadId: "thread-b" }));
  assert.notEqual(key(), key({ workspaceCwd: "/another-workspace" }));
  assert.notEqual(key(), key({ channel: { boundPath: "/another-path" } }));
  assert.notEqual(key(), key({ policyRevision: "new-policy" }));
  assert.notEqual(key({ branchId: "", threadId: "root" }), key({ branchId: "", threadId: undefined }));
  assert.notEqual(key({ threadId: undefined, draftId: "creation-a" }), key({ threadId: undefined, draftId: "creation-b" }));
  assert.notEqual(key({ threadId: undefined, draftId: "creation-a" }), key());
  const oldScope = { workspaceCwd: "/shared/execution", conversationId: "channel:channel:branch:branch", policyRevision: "policy" };
  assert.notEqual(key(), fullAccessConfirmationScopeKey(oldScope));
});

test("a background work confirmation uses its source thread and never the selected chat", () => {
  const input = { requestBody: { cwd: "/workspace", threadId: "origin-a", task: { channelId: "channel", id: "task" } },
    fallbackWorkspaceCwd: "/workspace", selectedChannelId: "channel", selectedChannelBranchId: "selected-b", policyRevision: "policy" };
  const scope = fullAccessRunScope(input);
  assert.deepEqual(scope, fullAccessRunScope({ ...input, selectedChannelBranchId: "selected-c" }));
  assert.equal(scope.conversationId, channelFullAccessScope({ channel: undefined, channelId: "channel", branchId: "",
    workspaceCwd: "/workspace", threadId: "origin-a", policyRevision: "policy" }).conversationId);
  const unowned = fullAccessRunScope({ ...input, requestBody: { task: { channelId: "channel", id: "task" } } });
  assert.notEqual(unowned.conversationId, scope.conversationId);
  assert.ok(unowned.conversationId.startsWith("channel-work-v2:"));
});

test("full access scope changes with conversation, cwd, and permission policy", () => {
  const policyRevision = fullAccessPolicyRevision({
    defaultAuthorizationMode: "smart",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
    approvalPolicyUpdatedAt: "2026-07-28T08:00:00.000Z",
  });
  const base = fullAccessConfirmationScopeKey({
    workspaceCwd: "/workspace/a",
    conversationId: "conversation:one",
    policyRevision,
  });

  assert.notEqual(base, fullAccessConfirmationScopeKey({
    workspaceCwd: "/workspace/b",
    conversationId: "conversation:one",
    policyRevision,
  }));
  assert.notEqual(base, fullAccessConfirmationScopeKey({
    workspaceCwd: "/workspace/a",
    conversationId: "conversation:two",
    policyRevision,
  }));
  assert.notEqual(base, fullAccessConfirmationScopeKey({
    workspaceCwd: "/workspace/a",
    conversationId: "conversation:one",
    policyRevision: fullAccessPolicyRevision({
      defaultAuthorizationMode: "smart",
      defaultWorkspaceAccessMode: "full_access",
      defaultPermissionMode: "full_access",
      defaultPermissionPreset: "full_access",
      approvalPolicyUpdatedAt: "2026-07-28T09:00:00.000Z",
    }),
  }));
});

test("full access confirmation scope storage id is stable and opaque", () => {
  const scope = {
    workspaceCwd: "/private/workspace/path",
    conversationId: "conversation:one",
    policyRevision: "policy:one",
  };
  const storageId = fullAccessConfirmationScopeStorageId(scope);

  assert.equal(storageId, fullAccessConfirmationScopeStorageId(scope));
  assert.equal(storageId.includes(scope.workspaceCwd), false);
  assert.notEqual(storageId, fullAccessConfirmationScopeStorageId({ ...scope, conversationId: "conversation:two" }));
});

test("full access confirmations survive a storage round trip and reject malformed records", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const scopeId = fullAccessConfirmationScopeStorageId({
    workspaceCwd: "/workspace/a",
    conversationId: "conversation:one",
    policyRevision: "policy:one",
  });
  const confirmation = {
    mode: "full_access",
    confirmed: true,
    confirmedAt: "2026-07-29T10:00:00.000Z",
    reason: "user_confirmed_full_access",
  };
  const confirmations = new Map();
  rememberFullAccessConfirmation(confirmations, scopeId, confirmation);
  persistFullAccessConfirmations(storage, confirmations);

  assert.deepEqual(loadFullAccessConfirmations(storage).get(scopeId), confirmation);
  values.set("ling-stack.full-access-confirmations.v1", "{not-json");
  assert.equal(loadFullAccessConfirmations(storage).size, 0);
});
