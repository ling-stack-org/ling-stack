import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput, readPreparedRunnerInput, restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";

const profile = "host_isolated_files_v1";
const names = ["read", "grep", "find", "ls", "write", "edit"];
const surface = { mediaGeneration: false, toolHydration: false, nativeFileCreate: false, userInput: false, delegation: false };
const handled = { content: [{ type: "text", text: "CURRENT_HOST_RESULT" }] };

async function fixture(t, changes = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-prepared-isolated-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = new PiRunnerAdapter();
  const options = { cwd, agentDir: join(cwd, "agent"), task: { id: "isolated-task", title: "Bounded files", prompt: "Edit the selected file." },
    provider: { provider: "prepared-isolated-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false,
      apiKey: "private-provider-key", headers: { Authorization: "Bearer private-provider-key" } },
    isolatedToolsProfile: profile, initialToolSurface: { ...surface },
    runtimeToolFeatures: { requestPermissions: false, unifiedExec: false, shellSnapshot: false },
    onToolBefore: () => ({ allowed: true }), onIsolatedToolCall: () => handled,
    onApprovalRequired: () => ({ approved: true, handledResult: handled }), ...changes };
  const preparedInput = await runner.prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  return { options, preparedInput, payload, runner };
}

function changePrepared(payload, change) {
  const copy = structuredClone(payload);
  change(copy.preparedInput);
  const { fingerprint: _fingerprint, ...body } = copy.preparedInput;
  copy.preparedInput.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return copy;
}

for (const tools of [undefined, [], ["read"], ["write", "edit"], names]) {
  test(`isolated capture/restore pins profile and ${tools?.length ?? "default"} exact tools without persisting authority`, async t => {
    const f = await fixture(t, { tools });
    const expected = tools ?? names;
    assert.equal(f.payload.input.isolatedToolsProfile, profile);
    assert.deepEqual(f.payload.input.tools, expected);
    assert.deepEqual(f.payload.preparedInput.tools.map(tool => tool.name).sort(), [...expected].sort());
    assert.equal(f.payload.toolHydrationEnabled, false);
    assert.deepEqual(f.payload.input.initialToolSurface, surface);
    assert.equal(f.payload.input.provider.apiKey, undefined);
    assert.equal(f.payload.input.provider.headers, undefined);
    for (const key of ["onIsolatedToolCall", "onToolBefore", "onApprovalRequired", "onPermissionRequired", "onUserInputRequest",
      "signal", "sandbox", "approvalProfile", "permissionMode", "workflowIsolationPlan"]) assert.equal(f.payload.input[key], undefined, key);
    assert.doesNotMatch(JSON.stringify(f.payload), /private-provider-key/);
    assert.deepEqual(readPreparedRunnerInput(JSON.parse(JSON.stringify(f.payload)), f.options), f.payload);
    const onIsolatedToolCall = request => ({ ...handled, details: { toolCallId: request.toolCallId } });
    let approvals = 0;
    const onApprovalRequired = () => { approvals++; return { approved: true, handledResult: handled }; };
    const current = { ...f.options, onIsolatedToolCall, onApprovalRequired,
      provider: { ...f.options.provider, apiKey: "rotated-private-key", headers: { Authorization: "Bearer rotated-private-key" } } };
    const restored = restorePreparedRunnerOptions(f.payload, current);
    assert.equal(restored.isolatedToolsProfile, profile);
    assert.deepEqual(restored.tools, expected);
    assert.deepEqual(restored.initialToolSurface, surface);
    assert.equal(restored.onIsolatedToolCall, onIsolatedToolCall);
    assert.equal(restored.onApprovalRequired, onApprovalRequired);
    assert.equal(restored.provider, current.provider);
    assert.equal((await restored.onApprovalRequired({})).handledResult, handled);
    assert.equal(approvals, 1);
    assert.equal((await f.runner.prepareTaskInput(restored)).fingerprint, f.preparedInput.fingerprint);
  });
}

test("isolated capture snapshots tools and initial surface without rewriting caller selection", async t => {
  const tools = ["read", "edit"], initialToolSurface = { ...surface };
  const f = await fixture(t, { tools, initialToolSurface });
  tools.push("bash");
  initialToolSurface.delegation = true;
  assert.deepEqual(f.payload.input.tools, ["read", "edit"]);
  assert.deepEqual(f.payload.input.initialToolSurface, surface);
  assert.throws(() => capturePreparedRunnerInput({ runnerId: "pi", options: f.options, preparedInput: f.preparedInput }), /Invalid prepared Host isolated-files/);
  assert.deepEqual(tools, ["read", "edit", "bash"], "never trim incompatible required tools");
});

test("restore pins both profile directions and does not promote legacy/readonly evidence", async t => {
  const f = await fixture(t);
  for (const changes of [{ isolatedToolsProfile: undefined }, { isolatedToolsProfile: "future_profile" },
    { isolatedToolsProfile: undefined, readonlyToolsProfile: "host_readonly_v1" }, { readonlyToolsProfile: "host_readonly_v1" }]) {
    assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options, ...changes }), error => error.code === "workflow_safety_mismatch");
  }
  for (const readonlyToolsProfile of [undefined, "host_readonly_v1"]) {
    const legacy = await fixture(t, { tools: ["read"], isolatedToolsProfile: undefined, onIsolatedToolCall: undefined,
      readonlyToolsProfile, onReadonlyToolCall: readonlyToolsProfile ? () => handled : undefined });
    assert.throws(() => restorePreparedRunnerOptions(legacy.payload, { ...legacy.options, readonlyToolsProfile: undefined,
      isolatedToolsProfile: profile, onIsolatedToolCall: () => handled }), error => error.code === "workflow_safety_mismatch");
    assert.equal(restorePreparedRunnerOptions(legacy.payload, legacy.options).isolatedToolsProfile, undefined);
  }
});

test("capture rejects wrong profiles, missing Host bindings and incompatible required tools before dropping callbacks", async t => {
  const f = await fixture(t);
  for (const changes of [{ isolatedToolsProfile: "future_profile" }, { readonlyToolsProfile: "host_readonly_v1" },
    { onToolBefore: undefined }, { onIsolatedToolCall: undefined }, { tools: ["read", "bash"] }, { tools: null }, { tools: ["read", "read"] }]) {
    assert.throws(() => capturePreparedRunnerInput({ runnerId: "pi", options: { ...f.options, ...changes }, preparedInput: f.preparedInput }), /Invalid prepared Host isolated-files/);
  }
  assert.throws(() => capturePreparedRunnerInput({ runnerId: "codex", options: f.options, preparedInput: f.preparedInput }), /Invalid prepared Host isolated-files/);
  for (const key of ["onMcpToolCall", "onHostCapabilityCall", "onMediaGenerationToolCall", "onToolHydrationRequest",
    "onDelegationToolCall", "onUserInputRequest", "onPermissionRequired"]) {
    const current = { ...f.options, [key]: () => assert.fail("external producer must never run") };
    assert.throws(() => capturePreparedRunnerInput({ runnerId: "pi", options: current, preparedInput: f.preparedInput }), /Invalid prepared Host isolated-files/);
    assert.throws(() => restorePreparedRunnerOptions(f.payload, current), error => error.code === "workflow_safety_mismatch");
  }
});

test("serialized isolated evidence rejects profile conflicts, widening, and mismatched selected descriptors", async t => {
  const f = await fixture(t);
  const mutations = [
    value => { value.runnerId = "codex"; },
    value => { value.input.isolatedToolsProfile = "future_profile"; },
    value => { value.input.isolatedToolsProfile = null; },
    value => { value.input.readonlyToolsProfile = "host_readonly_v1"; },
    value => { value.toolHydrationEnabled = true; },
    ...[["read", "bash"], ["read", "read"], ["read"], null, "read"].map(tools => value => { value.input.tools = tools; }),
    ...["mcpTools", "hostCapabilityTools", "mediaGenerationTools"].flatMap(key => [
      value => { value.input[key] = [{ name: "write", registeredName: "write" }]; },
      value => { value.input[key] = {}; },
    ]),
    ...Object.keys(surface).map(key => value => { value.input.initialToolSurface[key] = true; }),
    ...["requestPermissions", "unifiedExec", "shellSnapshot"].map(key => value => { value.input.runtimeToolFeatures[key] = true; }),
    value => { value.input.initialToolSurface.unknown = false; },
    value => { value.input.runtimeToolFeatures.unknown = false; },
    value => { value.input.initialToolSurface = null; },
    value => { value.input.runtimeToolFeatures = "disabled"; },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(f.payload);
    mutate(forged);
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared Host isolated-files/);
  }
  const missingSelection = structuredClone(f.payload);
  delete missingSelection.input.tools;
  assert.deepEqual(readPreparedRunnerInput(missingSelection, f.options).preparedInput, f.preparedInput, "omitted selection means all six, never SDK defaults");
});

test("narrow prepared checks reject forbidden tools and legacy write/edit or regex schemas even with a valid fingerprint", async t => {
  const f = await fixture(t);
  for (const name of ["bash", "mcp_fixture", "image_generate", "host_open_local_target", "request_user_input", "spawn_agent", "tool_search"]) {
    const forged = changePrepared(f.payload, prepared => { prepared.tools[0].name = name; });
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared Host isolated-files tool surface/);
  }
  const mutations = [
    prepared => { prepared.tools.pop(); },
    prepared => { prepared.tools.find(tool => tool.name === "grep").parameters.properties.literal.const = false; },
    prepared => { prepared.tools.find(tool => tool.name === "write").parameters = { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"] }; },
    prepared => { prepared.tools.find(tool => tool.name === "edit").parameters = { type: "object", properties: {
      path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] }; },
    prepared => { delete prepared.tools.find(tool => tool.name === "edit").parameters.properties.edits.minItems; },
    prepared => { prepared.tools.find(tool => tool.name === "edit").parameters.properties.edits.items.required = ["newText"]; },
  ];
  for (const mutate of mutations) {
    const forged = changePrepared(f.payload, mutate);
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared Host isolated-files tool surface/);
    assert.throws(() => restorePreparedRunnerOptions(forged, f.options), /Invalid prepared Host isolated-files tool surface/);
  }
});

test("restore rejects current selection or external-surface drift instead of silently trimming it", async t => {
  const f = await fixture(t, { tools: ["read", "write"] });
  for (const tools of [["read"], ["read", "write", "edit"], undefined]) {
    assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options, tools }), error => error.code === "prepared_tool_capability_changed");
  }
  for (const changes of [{ tools: ["read", "bash"] }, { onToolBefore: undefined }, { onIsolatedToolCall: undefined },
    ...Object.keys(surface).map(key => ({ initialToolSurface: { ...surface, [key]: true } })),
    ...["mcpTools", "hostCapabilityTools", "mediaGenerationTools"].map(key => ({ [key]: [{ name: "external" }] })),
    { runtimeToolFeatures: { requestPermissions: true } }]) {
    assert.throws(() => restorePreparedRunnerOptions(f.payload, { ...f.options, ...changes }), error => error.code === "workflow_safety_mismatch");
  }
  const restored = restorePreparedRunnerOptions(f.payload, { ...f.options, tools: ["write", "read"] });
  assert.deepEqual(restored.tools, ["read", "write"], "same current selection retains the frozen order");
});

test("serialized callbacks and permission fields cannot be restored as authority", async t => {
  const f = await fixture(t);
  for (const key of ["onIsolatedToolCall", "onToolBefore", "onApprovalRequired", "onPermissionRequired", "onUserInputRequest",
    "sandbox", "approvalProfile", "permissionMode", "workflowIsolationPlan"]) {
    const forged = structuredClone(f.payload);
    forged.input[key] = "fabricated-authority";
    assert.throws(() => readPreparedRunnerInput(forged, f.options), /Invalid prepared execution payload/);
    assert.throws(() => restorePreparedRunnerOptions(forged, f.options), /Invalid prepared execution payload/);
  }
});

test("public Run parser accepts neither isolated producers nor the Host-only isolation plan binding", () => {
  const parsed = parseRunRequest({ cwd: "/fixture", task: { id: "external", title: "External", prompt: "External" },
    provider: { provider: "fixture", model: "fixture" }, isolatedToolsProfile: profile, readonlyToolsProfile: "host_readonly_v1",
    onIsolatedToolCall: "forged-callback", onApprovalRequired: "forged-approval",
    workflowIsolationPlan: { planId: "forged-plan", planDigest: "forged-digest" } });
  for (const key of ["isolatedToolsProfile", "readonlyToolsProfile", "onIsolatedToolCall", "onApprovalRequired", "workflowIsolationPlan"]) {
    assert.equal(parsed[key], undefined, key);
  }
});
