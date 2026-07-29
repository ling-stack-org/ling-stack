import assert from "node:assert/strict";
import test from "node:test";

import {
  fullAccessConfirmationScopeKey,
  fullAccessConfirmationScopeStorageId,
  fullAccessPolicyRevision,
} from "../src/app/full-access-confirmation-scopes.ts";
import {
  loadFullAccessConfirmations,
  persistFullAccessConfirmations,
  rememberFullAccessConfirmation,
} from "../src/app/full-access-confirmation-storage.ts";

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
