import assert from "node:assert/strict";
import test from "node:test";
import {
  channelOperationPlanFingerprintV1,
  isChannelCommandInputScopeV1,
  isChannelIntentExecutionPlanV1,
  isChannelOperationBindingV1,
} from "../dist/index.js";

const now = "2026-10-27T08:00:00.000Z";
const authority = () => ({
  kind: "channel_effective_policy_v1", channelId: "channel", workspaceId: "workspace",
  participantId: "qa", operationId: "validate", sourceItemId: "user", sourceRevision: 0,
  workspaceCwd: "/workspace", executionCwd: "/workspace",
  workspaceRootIdentity: { device: "1", inode: "2" }, executionRootIdentity: { device: "1", inode: "2" },
  channelUpdatedAt: now, workspacePolicyUpdatedAt: now, policyFingerprint: "a".repeat(64),
});
const source = { itemId: "user", revision: 0, actorType: "local_user", quote: "@QA 运行 node project/validate.mjs" };
const policyScope = () => ({ kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [], policyAuthority: authority() });
const binding = () => ({ schemaVersion: 1, ownerParticipantId: "qa", ownerSelection: "explicit",
  inputRefs: [{ path: "project/validate.mjs", sourceRefs: [source] }], outputRefs: [], sourceRefs: [source],
  commandInputScope: policyScope(), effectScope: { readPaths: ["project/validate.mjs"], writePaths: [],
    exactCommands: ["node project/validate.mjs"], allowEnvironmentAccess: false, allowNetworkAccess: false } });
const operation = () => ({ id: "validate", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
  targetRef: { type: "operation", id: "user:validate", label: "node project/validate.mjs" },
  commandMatchPolicy: { kind: "exact_command", command: "node project/validate.mjs" }, binding: binding() });
const plan = operations => ({ bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) });

test("Host policy scope accepts a verified execution root without inventing user provenance", () => {
  const scope = policyScope();
  assert.equal(isChannelCommandInputScopeV1(scope), true);
  assert.deepEqual(scope.sourceRefs, []);
  assert.equal(isChannelOperationBindingV1(binding()), true);
  assert.equal(isChannelIntentExecutionPlanV1(plan([operation()])), true);
});

test("policy authority is a strict identity snapshot, never a serialized permission boolean", () => {
  for (const mutate of [
    a => { a.kind = "allow"; }, a => { a.channelId = ""; }, a => { a.workspaceId = ""; },
    a => { a.participantId = ""; }, a => { a.operationId = ""; }, a => { a.sourceItemId = ""; },
    a => { a.sourceRevision = -1; }, a => { a.sourceRevision = 0.5; },
    a => { a.sourceRevision = Number.MAX_SAFE_INTEGER + 1; },
    a => { a.workspaceCwd = "relative"; }, a => { a.executionCwd = ""; },
    a => { a.workspaceRootIdentity.device = ""; }, a => { a.workspaceRootIdentity.inode = 2; },
    a => { a.executionRootIdentity.inode = "not-an-inode"; }, a => { a.executionRootIdentity.extra = true; },
    a => { a.channelUpdatedAt = "yesterday"; }, a => { a.workspacePolicyUpdatedAt = ""; },
    a => { a.policyFingerprint = "bad"; }, a => { a.policyFingerprint = "g".repeat(64); },
    a => { a.allow = true; }, a => { delete a.sourceItemId; }, a => { delete a.workspaceRootIdentity; },
  ]) {
    const scope = policyScope(); mutate(scope.policyAuthority);
    assert.equal(isChannelCommandInputScopeV1(scope), false, String(mutate));
  }
});

test("policy scope is exactly the execution root with no synthetic source refs", () => {
  for (const patch of [{ projectRoot: "project" }, { projectRoot: "/" }, { projectRoot: "../workspace" },
    { sourceRefs: [source] }, { sourceRefs: undefined }, { policyAuthority: null }, { verified: true }]) {
    assert.equal(isChannelCommandInputScopeV1({ ...policyScope(), ...patch }), false, JSON.stringify(patch));
  }
});

test("standalone bindings enforce the authority owner even without an operation id", () => {
  const value = binding(); value.commandInputScope.policyAuthority.participantId = "engineer";
  assert.equal(isChannelOperationBindingV1(value), false);
});

test("policy source identity must be present in the original local-user binding provenance", () => {
  for (const mutate of [
    b => { b.commandInputScope.policyAuthority.sourceItemId = "another-user-item"; },
    b => { b.commandInputScope.policyAuthority.sourceRevision = 1; },
    b => { b.sourceRefs = [{ ...source, actorType: "ling_agent" }]; },
    b => { b.sourceRefs = [{ ...source, actorType: undefined }]; },
    b => { b.sourceRefs = [{ ...source, revision: undefined }]; },
  ]) {
    const value = binding(); mutate(value);
    assert.equal(isChannelOperationBindingV1(value), false, String(mutate));
  }
});

test("the complete plan enforces authority operation identity even with a recomputed fingerprint", () => {
  const value = operation(); value.binding.commandInputScope.policyAuthority.operationId = "another-operation";
  assert.equal(isChannelOperationBindingV1(value.binding), true, "a standalone binding has no enclosing operation id");
  assert.equal(isChannelOperationBindingV1(value.binding, value.id), false);
  assert.equal(isChannelIntentExecutionPlanV1(plan([value])), false);
});

test("policy scopes keep a direct JavaScript entry input and one exact Node command", () => {
  for (const extension of ["js", "mjs", "cjs"]) {
    const value = operation(), path = `validate.${extension}`;
    value.binding.inputRefs[0].path = path;
    value.binding.effectScope.readPaths = [path];
    value.binding.effectScope.exactCommands = [value.commandMatchPolicy.command = `node ${path}`];
    assert.equal(isChannelIntentExecutionPlanV1(plan([value])), true);
  }
  for (const mutate of [
    b => { b.inputRefs = []; b.effectScope.readPaths = []; },
    b => { b.inputRefs[0].path = "project/data.json"; b.effectScope.readPaths = ["project/data.json"]; },
    b => { b.effectScope.exactCommands = []; },
    b => { b.effectScope.exactCommands.push("node project/second.mjs"); },
    b => { b.effectScope.exactCommands = ["python project/validate.mjs"]; },
    b => { b.effectScope.exactCommands = ["node project/validate.mjs\necho injected"]; },
  ]) {
    const value = binding(); mutate(value);
    assert.equal(isChannelOperationBindingV1(value), false, String(mutate));
  }
  const value = operation(); value.kind = "file_read"; value.targetKind = "file";
  delete value.commandMatchPolicy;
  assert.equal(isChannelIntentExecutionPlanV1(plan([value])), false);
});

test("explicit user scopes retain their original representation and narrower directory provenance", () => {
  const ref = { ...source, quote: "在项目目录 project 内运行 node project/validate.mjs" };
  const value = binding(); value.sourceRefs = [ref]; value.inputRefs[0].sourceRefs = [ref];
  value.commandInputScope = { kind: "node_module_closure_v1", projectRoot: "project",
    sourceRefs: [{ ...ref, quote: "项目目录 project 内" }] };
  assert.equal(isChannelCommandInputScopeV1(value.commandInputScope), true);
  assert.equal(isChannelOperationBindingV1(value), true);
  const encoded = JSON.stringify(value.commandInputScope);
  assert.equal("policyAuthority" in value.commandInputScope, false);
  assert.equal(JSON.stringify(value.commandInputScope), encoded);
  for (const patch of [{ sourceRefs: [] }, { projectRoot: "." }, { projectRoot: ".private" },
    { sourceRefs: [{ ...ref, actorType: "ling_agent" }] }]) {
    assert.equal(isChannelCommandInputScopeV1({ ...value.commandInputScope, ...patch }), false);
  }
  value.commandInputScope.sourceRefs = [{ ...source, quote: "project" }];
  value.sourceRefs = [source];
  assert.equal(isChannelOperationBindingV1(value), false, "a path prefix inside a command is still not project authority");
});
