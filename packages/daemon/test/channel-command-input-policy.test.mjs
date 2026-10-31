import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import {
  assertChannelCommandInputPolicyCurrent,
  compileChannelCommandInputPolicyScope,
} from "../dist/features/channels/channel-command-input-policy.js";

const now = "2026-10-27T14:00:00.000Z";
const participantId = "command-policy-owner";
const changed = { code: "restricted_command_input_policy_changed" };

async function fixture(t, mode = "local") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-command-policy-")));
  const cwd = join(root, "workspace"), executionCwd = mode === "local" ? cwd : join(root, "execution");
  await mkdir(cwd);
  if (executionCwd !== cwd) await mkdir(executionCwd);
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.updateApprovalPolicy({ toolDecisions: { read: "allow" } }, now);
  store.createAiTeammate({ id: participantId, roleKey: "qa", displayName: "Policy QA", description: "Isolated fixture",
    allowedTools: ["read", "bash"], approvalProfile: { mode: "none" } }, now);
  const channel = store.createChannel({ name: "Command policy", boundPath: cwd, allowedTools: ["read", "bash"],
    ...(mode === "local" ? {} : { workspaceBinding: { mode, status: "ready", updatedAt: now,
      ...(mode === "managed_worktree" ? { worktreePath: executionCwd } : { executionPath: executionCwd }) } }) }, now);
  store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body: "@Policy QA 运行 node project/main.mjs；入口 project/main.mjs。",
    mentions: [{ kind: "ai-teammate", id: participantId, label: "Policy QA" }] }, now);
  const context = { store, channelId: channel.id, participantId, operationId: "run-main", sourceItemId: source.id,
    workspaceCwd: cwd };
  const compile = (overrides = {}) => compileChannelCommandInputPolicyScope({ ...context, ...overrides });
  const check = (scope, overrides = {}) => assertChannelCommandInputPolicyCurrent({ ...context, scope,
    effectiveReadDecision: "allow", ...overrides });
  return { root, cwd, executionCwd, store, channel, source, context, compile, check };
}

test("Host compiles canonical read authority without a user quote or project file access", async t => {
  const f = await fixture(t), scope = f.compile();
  assert.ok(scope);
  assert.deepEqual({ kind: scope.kind, projectRoot: scope.projectRoot, sourceRefs: scope.sourceRefs },
    { kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [] });
  const authority = scope.policyAuthority;
  assert.equal(authority.kind, "channel_effective_policy_v1");
  assert.equal(authority.channelId, f.channel.id);
  assert.equal(authority.workspaceId, f.channel.workspaceId);
  assert.equal(authority.participantId, participantId);
  assert.equal(authority.operationId, "run-main");
  assert.equal(authority.sourceItemId, f.source.id);
  assert.equal(authority.sourceRevision, f.store.getConversationItem(f.source.id).revision);
  assert.equal(authority.workspaceCwd, f.cwd);
  assert.equal(authority.executionCwd, f.cwd);
  assert.match(authority.policyFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.compile(), scope);
  f.check(scope);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
});

for (const mode of ["external_path", "managed_worktree"]) {
  test(`${mode} binds the actual execution root separately from Store root`, async t => {
    const f = await fixture(t, mode), scope = f.compile();
    assert.ok(scope);
    assert.equal(scope.policyAuthority.workspaceCwd, f.cwd);
    assert.equal(scope.policyAuthority.executionCwd, f.executionCwd);
    assert.notDeepEqual(scope.policyAuthority.workspaceRootIdentity, scope.policyAuthority.executionRootIdentity);
    f.check(scope);
    assert.equal(f.compile({ workspaceCwd: f.executionCwd }), undefined, "An execution root cannot impersonate Store root");
  });
  test(`${mode} replacement at the same path invalidates directory identity`, async t => {
    const f = await fixture(t, mode), scope = f.compile();
    await rename(f.executionCwd, `${f.executionCwd}-previous`);
    await mkdir(f.executionCwd);
    assert.throws(() => f.check(scope), changed);
    assert.notDeepEqual(f.compile().policyAuthority.executionRootIdentity, scope.policyAuthority.executionRootIdentity);
  });
}

test("workspace root replacement invalidates a frozen scope even if its path is unchanged", async t => {
  const f = await fixture(t), scope = f.compile();
  await rename(f.cwd, `${f.cwd}-previous`);
  await mkdir(f.cwd);
  assert.throws(() => f.check(scope), changed);
});

for (const [name, mutate] of [
  ["workspace read ask", f => f.store.updateApprovalPolicy({ toolDecisions: { read: "ask" } }, now)],
  ["workspace read deny", f => f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now)],
  ["channel read removal", f => f.store.updateChannel(f.channel.id, { allowedTools: ["bash"] }, now)],
  ["owner read removal", f => f.store.updateAiTeammate(participantId, { allowedTools: ["bash"] }, now)],
  ["owner explicit read approval", f => f.store.updateAiTeammate(participantId,
    { approvalProfile: { mode: "strict", requiredForTools: ["read"] } }, now)],
  ["owner disabled", f => f.store.updateAiTeammate(participantId, { status: "disabled" }, now)],
  ["owner hidden", f => f.store.updateAiTeammate(participantId, { hidden: true }, now)],
  ["channel paused", f => f.store.updateChannel(f.channel.id, { status: "paused" }, now)],
  ["workspace not ready", f => f.store.updateChannel(f.channel.id,
    { workspaceBinding: { mode: "local", status: "blocked", updatedAt: now } }, now)],
  ["channel membership removed", f => f.store.replaceTeammateChannelMemberships(participantId, [], now)],
]) test(`same-timestamp ${name} revokes inherited authority`, async t => {
  const f = await fixture(t), scope = f.compile();
  assert.ok(scope);
  mutate(f);
  assert.equal(f.compile(), undefined);
  assert.throws(() => f.check(scope), changed);
});

test("same updatedAt does not hide policy contents changing while read remains allow", async t => {
  const f = await fixture(t), scope = f.compile();
  f.store.updateApprovalPolicy({ toolDecisions: { write: "deny" } }, now);
  const next = f.compile();
  assert.ok(next);
  assert.equal(next.policyAuthority.workspacePolicyUpdatedAt, scope.policyAuthority.workspacePolicyUpdatedAt);
  assert.notEqual(next.policyAuthority.policyFingerprint, scope.policyAuthority.policyFingerprint);
  assert.throws(() => f.check(scope), changed);
});

test("same-timestamp participant/profile and channel binding changes invalidate frozen content", async t => {
  const f = await fixture(t), scope = f.compile();
  f.store.updateAiTeammate(participantId, { approvalProfile: { mode: "strict" } }, now);
  assert.ok(f.compile(), "Strict risky-tool approval does not itself require read approval");
  assert.throws(() => f.check(scope), changed);
  const profiled = f.compile();
  f.store.updateChannel(f.channel.id, { workspaceBinding: { mode: "local", status: "ready", updatedAt: now } }, now);
  assert.throws(() => f.check(profiled), changed);
});

test("workspace default presets cannot silently convert actual read ask into allow", async t => {
  const f = await fixture(t);
  f.store.updateApprovalPolicy({ toolDecisions: { read: "ask" } }, now);
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: "always", defaultWorkspaceAccessMode: "full_access" }, now);
  assert.equal(f.compile(), undefined);
});

test("final execution read ask or deny rejects a still-current policy scope", async t => {
  const f = await fixture(t), scope = f.compile();
  for (const effectiveReadDecision of ["ask", "deny"]) {
    assert.throws(() => f.check(scope, { effectiveReadDecision }), { code: "restricted_command_input_read_not_allowed" });
  }
  f.check(scope, { effectiveReadDecision: "allow" });
});

test("a revised source cannot reuse the authority from its replaced canonical item", async t => {
  const f = await fixture(t), scope = f.compile(), item = f.store.getConversationItem(f.source.id);
  f.store.appendConversationItem({ channelId: item.channelId, threadId: item.threadId, turnId: item.turnId,
    kind: item.kind, status: "committed", actorType: item.actorType, visibility: item.visibility,
    payload: { ...item.payload, body: `${item.payload.body} 取消执行。` }, domainRefs: item.domainRefs,
    supersedesItemId: item.id }, now);
  assert.equal(f.compile(), undefined);
  assert.throws(() => f.check(scope), changed);
});

test("effective turn assignment changes invalidate even an otherwise unchanged source", async t => {
  const f = await fixture(t), scope = f.compile(), item = f.store.getConversationItem(f.source.id);
  const previous = f.store.getEffectiveTurnContextAssignment(item.turnId);
  f.store.applyTurnContextAssignment({ turnId: item.turnId, expectedPreviousRevision: previous.revision,
    target: { kind: "new", state: "active" }, status: "committed", decisionSource: "user", policyVersion: "test-v2" }, now);
  assert.ok(f.compile());
  assert.throws(() => f.check(scope), changed);
});

test("cross-channel and assistant sources cannot issue policy authority", async t => {
  const f = await fixture(t);
  const other = f.store.createChannel({ name: "Other", allowedTools: ["read", "bash"] }, now);
  assert.equal(f.compile({ channelId: other.id }), undefined);
  const assistant = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "ai-teammate",
    authorId: participantId, body: "A model assertion is not a user instruction." }, now);
  assert.equal(f.compile({ sourceItemId: assistant.id }), undefined);
  const scope = f.compile();
  assert.throws(() => f.check(scope, { operationId: "other-operation" }), changed);
  assert.throws(() => f.check(scope, { participantId: "teammate_builtin_engineer" }), changed);
  const forged = structuredClone(scope);
  forged.policyAuthority.sourceRevision++;
  assert.throws(() => f.check(forged), changed);
});

test("a local-user-shaped item that is not its turn's canonical input cannot issue authority", async t => {
  const f = await fixture(t), original = f.store.getConversationItem(f.source.id);
  const extra = f.store.appendConversationItem({ channelId: original.channelId, threadId: original.threadId,
    turnId: original.turnId, kind: "user_message", status: "committed", actorType: "local_user",
    visibility: original.visibility, payload: { ...original.payload, body: "An unbound extra user item" }, domainRefs: [] }, now);
  assert.equal(f.compile({ sourceItemId: extra.id }), undefined);
});

test("a symlink or missing execution root never issues authority", async t => {
  const f = await fixture(t, "external_path");
  await rename(f.executionCwd, `${f.executionCwd}-actual`);
  assert.equal(f.compile(), undefined);
  await symlink(`${f.executionCwd}-actual`, f.executionCwd);
  assert.equal(f.compile(), undefined);
});

test("legacy and explicitly quoted scopes are not recompiled, changed or expanded", async t => {
  const f = await fixture(t);
  const quoted = { kind: "node_module_closure_v1", projectRoot: "project",
    sourceRefs: [{ itemId: f.source.id, revision: 0, actorType: "local_user", quote: "project" }] };
  const before = structuredClone(quoted);
  f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now);
  f.check(undefined, { effectiveReadDecision: "deny" });
  f.check(quoted, { effectiveReadDecision: "deny" });
  assert.deepEqual(quoted, before);
  assert.equal(quoted.policyAuthority, undefined);
});

test("malformed serialized policy scope and unavailable canonical state fail with fixed codes", async t => {
  const f = await fixture(t), scope = f.compile(), malformed = structuredClone(scope);
  malformed.sourceRefs.push({ itemId: f.source.id, actorType: "local_user", revision: 0, quote: "." });
  assert.throws(() => f.check(malformed), changed);
  const readSnapshot = f.store.readSnapshot;
  f.store.readSnapshot = () => { throw new Error("Synthetic storage failure"); };
  try { assert.throws(() => f.check(scope), changed); } finally { f.store.readSnapshot = readSnapshot; }
});
