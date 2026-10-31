import assert from "node:assert/strict";
import test from "node:test";
import { ConversationPermissionSelectionController } from "../src/shared/conversation/conversation-permission-selection.ts";

function fixture(access = "read_only") {
  const pending = Promise.withResolvers(), changes = [], errors = [];
  let input = { ownerKey: "workspace/channel/policy-v1", authorizationMode: "ask", workspaceAccessMode: access,
    defaultWorkspaceAccessMode: "workspace_write", disabled: false,
    confirmFullAccess: () => pending.promise, onChange(selection) { changes.push(selection); input = { ...input, ...selection }; controller.update(input); },
    onError(error) { errors.push(error); } };
  const controller = new ConversationPermissionSelectionController(input);
  return { controller, pending, changes, errors, update(patch) { input = { ...input, ...patch }; controller.update(input); } };
}
const confirmed = { confirmed: true, mode: "full_access", reason: "user_confirmed_full_access" };

for (const access of ["read_only", "workspace_write"]) {
  test(`approval shortcuts preserve ${access}; explicit full access restores it on exit`, async () => {
    const f = fixture(access);
    await f.controller.select("smart");
    assert.deepEqual(f.changes.at(-1), { authorizationMode: "smart", workspaceAccessMode: access });
    const selecting = f.controller.select("always");
    assert.equal(f.changes.length, 1);
    f.pending.resolve(confirmed);
    await selecting;
    assert.deepEqual(f.changes.at(-1), { authorizationMode: "always", workspaceAccessMode: "full_access" });
    await f.controller.select("ask");
    assert.deepEqual(f.changes.at(-1), { authorizationMode: "ask", workspaceAccessMode: access });
  });
}
test("cancelling confirmation changes neither authorization nor sandbox", async () => {
  const f = fixture();
  const selecting = f.controller.select("always");
  f.pending.resolve(undefined);
  await selecting;
  assert.deepEqual(f.changes, []);
});
for (const patch of [{ ownerKey: "other-channel" }, { ownerKey: "workspace/channel/policy-v2" },
  { disabled: true }, { workspaceAccessMode: "workspace_write" }, { authorizationMode: "smart" },
  { defaultWorkspaceAccessMode: "read_only" }]) {
  test(`late confirmation is discarded after ${JSON.stringify(patch)}, even after restoring the old value`, async () => {
    const f = fixture();
    const selecting = f.controller.select("always");
    f.update(patch);
    f.update({ ownerKey: "workspace/channel/policy-v1", authorizationMode: "ask", workspaceAccessMode: "read_only",
      defaultWorkspaceAccessMode: "workspace_write", disabled: false });
    f.pending.resolve(confirmed);
    await selecting;
    assert.deepEqual(f.changes, []);
  });
}
test("late confirmation cannot publish after unmount or reattach", async () => {
  const f = fixture();
  const selecting = f.controller.select("always");
  f.controller.detach(); f.controller.attach();
  f.pending.resolve(confirmed);
  await selecting;
  assert.deepEqual(f.changes, []);
});
test("a newer selection invalidates a pending full access selection", async () => {
  const f = fixture();
  const selecting = f.controller.select("always");
  await f.controller.select("smart");
  f.pending.resolve(confirmed);
  await selecting;
  assert.deepEqual(f.changes, [{ authorizationMode: "smart", workspaceAccessMode: "read_only" }]);
});
test("disabled controls do not request or apply permission changes", async () => {
  const f = fixture(); let calls = 0;
  f.update({ disabled: true, confirmFullAccess: async () => { calls++; return confirmed; } });
  await f.controller.select("always"); await f.controller.select("smart");
  assert.equal(calls, 0); assert.deepEqual(f.changes, []);
});
test("a confirmation failure is visible but never changes permissions", async () => {
  const f = fixture(); const error = new Error("synthetic confirmation failure");
  const selecting = f.controller.select("always"); f.pending.reject(error); await selecting;
  assert.deepEqual(f.errors, [error]); assert.deepEqual(f.changes, []);
});
test("late confirmation errors are not reported into a different owner", async () => {
  const f = fixture();
  const selecting = f.controller.select("always"); f.update({ ownerKey: "other-teammate" });
  f.pending.reject(new Error("old owner")); await selecting;
  assert.deepEqual(f.errors, []); assert.deepEqual(f.changes, []);
});
test("without a confirmation capability full access is rejected", async () => {
  const f = fixture(); f.update({ confirmFullAccess: undefined });
  await f.controller.select("always");
  assert.equal(f.errors.length, 1); assert.deepEqual(f.changes, []);
});
test("restored full access uses the workspace fallback when its prior sandbox is unknown", async () => {
  const f = fixture("full_access"); f.update({ authorizationMode: "always" });
  await f.controller.select("smart");
  assert.deepEqual(f.changes, [{ authorizationMode: "smart", workspaceAccessMode: "workspace_write" }]);
});
