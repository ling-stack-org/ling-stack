import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";
import { jsonStringLiteralForGeneratedSource } from "./support/generated-source.mjs";

const modelPath = "features/settings/workflow-template-authoring-model.ts";
const controllerPath = "features/settings/workflow-template-authoring-controller.ts";
const registrySource = fileURLToPath(new URL("../../../packages/contracts/src/workflow-template-registry.ts", import.meta.url));
const modelTransform = { anchor: '} from "@ling-stack/contracts";', replace: () => `} from ${JSON.stringify(registrySource)};` };
const modelExports = ["newWorkflowTemplateSession", "workflowTemplateSessionFromVersion", "importedWorkflowTemplateSession", "workflowTemplateDraftDirty",
  "validateWorkflowTemplateDraft", "newWorkflowTemplateStep", "removeWorkflowTemplateStep", "replaceWorkflowTemplateStep",
  "workflowTemplateDependencyWouldCycle", "setWorkflowTemplateMember", "setWorkflowTemplateParallelPolicy", "workflowTemplateHasExplicitAutoStart",
  "workflowTemplateCreateRequest", "workflowTemplatePublishedPin", "workflowTemplatePreviewKey", "workflowTemplateIsConflict"];
const apiNames = ["getWorkflowTemplateVersion", "listWorkflowTemplates", "previewWorkflowTemplate", "saveWorkflowTemplateVersion", "setWorkflowTemplateReviewStatus"];
const policy = { onRunFailed: "block_for_user", onRunCancelled: "cancel_workflow", onApprovalDenied: "block_for_user", retryable: true };
const baseTemplate = () => ({ schemaVersion: 1, id: "authoring-sample", name: "Review and verify", autoStartDefault: false,
  steps: [{ id: "left", name: "Inspect", prompt: "Inspect {{objective}}", teammateId: "member-left", dependsOn: [], sideEffectClass: "analysis_readonly", autoStart: false },
    { id: "right", name: "Verify", prompt: "Verify {{objective}}", teammateId: "member-right", dependsOn: ["left"], sideEffectClass: "test_artifact_only",
      parallelPolicy: { autoParallel: true, requiresArtifactOnly: true, maxParallelSiblings: 2, resourceKeys: ["artifact:tests"], cancelSiblingsOnFailure: true },
      maxParallelSiblings: 2, requestedRunnerId: "pi", providerPresetId: "loopback-provider", skillId: "fixture-skill", branchGroupId: "branches", joinGroupId: "join",
      dependencyMode: "all_succeeded", policy, autoStart: false,
      gates: [{ stage: "pre", title: "Approve inspection", reason: "Review inputs", approvalProfile: { mode: "strict", risk: "high", requiredForTools: ["write"], requiredForActions: ["write"] }, requiredForStatuses: ["claimed"] },
        { stage: "post", title: "Approve result", reason: "Review output", approvalProfile: { mode: "standard" } }] }] });
const digest = "a".repeat(64);
const timestamp = "2026-11-03T00:00:00.000Z";
function records(status = "draft") {
  const template = baseTemplate();
  const version = { kind: "workflow_template", id: template.id, workspaceId: "workspace", version: "1", digest, template, createdAt: timestamp };
  const entry = { kind: "workflow_template", id: template.id, workspaceId: "workspace", source: "workspace",
    visibility: { workspaceVisible: true, promotableToWorkspace: false }, reviewStatus: status, latestVersion: "1", revision: 1, createdAt: timestamp, updatedAt: timestamp,
    ...(["published", "builtin"].includes(status) ? { publishedVersion: { id: template.id, version: "1", digest } } : {}) };
  return { template, entry, version };
}
function previewResponse(template = baseTemplate(), pin = { id: template.id, version: "1", digest }) {
  return { templatePin: pin, graphFingerprint: "f".repeat(64), steps: template.steps.map(step => ({ templateStepId: step.id, title: step.name,
    prompt: step.prompt, autoStart: step.autoStart ?? false, policy: step.policy ?? policy, ...(step.gates ? { gates: step.gates } : {}),
    toParticipantId: step.teammateId ?? "member-left", toParticipantLabel: step.teammateId ?? "Default member", participantDigest: digest,
    requiredTools: ["write"], runnerId: "pi", providerPresetId: "loopback-provider", dependsOn: step.dependsOn ?? [],
    ...(step.sideEffectClass ? { sideEffectClass: step.sideEffectClass } : {}), ...(step.parallelPolicy ? { parallelPolicy: step.parallelPolicy } : {}) })) };
}
async function modelHarness(t) {
  return catalogConsumerHarness(t, { exports: { [modelPath]: modelExports }, transforms: { [modelPath]: [modelTransform] } });
}

test("authoring source model defaults are manual and preserves advanced fields through structured changes and JSON", async t => {
  const { module: m } = await modelHarness(t);
  const blank = m.newWorkflowTemplateSession("new-template");
  assert.equal(blank.draft.template.autoStartDefault, false);
  assert.equal(blank.draft.template.steps[0].autoStart, false);
  assert.equal(m.workflowTemplateDraftDirty(blank), false);
  assert.ok(m.validateWorkflowTemplateDraft(blank.draft).error);
  const imported = m.importedWorkflowTemplateSession(JSON.stringify(baseTemplate()));
  assert.equal(m.workflowTemplateDraftDirty(imported), true);
  assert.equal(m.validateWorkflowTemplateDraft(imported.draft).error, "");
  const original = imported.draft.template.steps[1];
  const changed = m.replaceWorkflowTemplateStep(imported.draft.template, original.id, { ...original, name: "Edited name" });
  const checked = m.validateWorkflowTemplateDraft({ version: "2", template: changed });
  assert.deepEqual(checked.template.steps[1], { ...original, name: "Edited name" });
  const roundTrip = m.importedWorkflowTemplateSession(JSON.stringify(checked.template));
  assert.deepEqual(roundTrip.draft.template, checked.template);
  assert.equal(m.setWorkflowTemplateMember(original, "teammate:new-member").teammateId, "new-member");
  assert.deepEqual(m.setWorkflowTemplateMember({ ...original, teammateTemplateId: "old", councilSlotKey: "slot" }, ""),
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== "teammateId")));
});

test("authoring source validation rejects malformed JSON, unknown fields, cycles and unsafe parallel execution", async t => {
  const { module: m } = await modelHarness(t);
  for (const json of ["not JSON", JSON.stringify({ ...baseTemplate(), scripts: ["arbitrary"] }), " ".repeat(1_048_577)]) {
    assert.throws(() => m.importedWorkflowTemplateSession(json));
  }
  const template = baseTemplate();
  assert.equal(m.workflowTemplateDependencyWouldCycle(template.steps, "left", "right"), true);
  assert.equal(m.workflowTemplateDependencyWouldCycle(template.steps, "right", "left"), false);
  const cycle = { ...template, steps: template.steps.map(step => ({ ...step, dependsOn: [step.id === "left" ? "right" : "left"] })) };
  assert.match(m.validateWorkflowTemplateDraft({ version: "1", template: cycle }).error, /cycle/u);
  const removed = m.removeWorkflowTemplateStep(template, "left");
  assert.deepEqual(removed.steps[0].dependsOn, []);
  assert.equal(m.newWorkflowTemplateStep([{ id: "step-2" }]).id, "step-3");
  const unsafe = { ...template, steps: [{ ...template.steps[0], sideEffectClass: "release", parallelPolicy: { autoParallel: true } }] };
  assert.match(m.validateWorkflowTemplateDraft({ version: "1", template: unsafe }).error, /cannot request/u);
});

test("parallel limit edits synchronize imported legacy values and clearing leaves pure JSON", async t => {
  const { module: m } = await modelHarness(t);
  const template = baseTemplate();
  const step = template.steps[1];
  const changed = m.setWorkflowTemplateParallelPolicy(step, { maxParallelSiblings: 3 });
  assert.equal(changed.maxParallelSiblings, 3);
  assert.equal(changed.parallelPolicy.maxParallelSiblings, 3);
  const cleared = m.setWorkflowTemplateParallelPolicy(changed, { maxParallelSiblings: undefined });
  assert.equal("maxParallelSiblings" in cleared, false);
  assert.equal("maxParallelSiblings" in cleared.parallelPolicy, false);
  assert.equal(m.validateWorkflowTemplateDraft({ version: "2", template: { ...template, steps: [cleared] } }).error.includes("missing dependency"), true);
  const independent = { ...cleared, dependsOn: [] };
  assert.equal(m.validateWorkflowTemplateDraft({ version: "2", template: { ...template, steps: [independent] } }).error, "");
  assert.equal(m.setWorkflowTemplateParallelPolicy({ ...step, parallelPolicy: undefined }, { autoParallel: false }).parallelPolicy.maxParallelSiblings, 2);
});

test("only a clean published exact pin and current channel/objective preview can create; autoStart is always false", async t => {
  const { module: m } = await modelHarness(t);
  const { entry, version } = records("published");
  const session = m.workflowTemplateSessionFromVersion(entry, version);
  assert.equal(session.draft.version, "2");
  assert.equal(m.workflowTemplateDraftDirty(session), false);
  const preview = { key: m.workflowTemplatePreviewKey(session, "channel", "Objective"), result: previewResponse() };
  assert.deepEqual(m.workflowTemplateCreateRequest(session, "channel", " Objective ", preview), {
    objective: "Objective", customTemplateId: entry.id, customTemplateVersion: "1", customTemplateDigest: digest, autoStart: false,
  });
  const rejected = ["draft", "disabled", "archived"].map(reviewStatus => ({ ...session, entry: { ...entry, reviewStatus } }));
  rejected.push({ ...session, conflict: true }, { ...session, draft: { ...session.draft, template: { ...session.draft.template, name: "Changed" } } });
  for (const value of rejected) assert.equal(m.workflowTemplateCreateRequest(value, "channel", "Objective", preview), undefined);
  assert.equal(m.workflowTemplateCreateRequest(session, "another-channel", "Objective", preview), undefined);
  assert.equal(m.workflowTemplateCreateRequest(session, "channel", "Different objective", preview), undefined);
  assert.equal(m.workflowTemplateCreateRequest(session, "channel", "Objective", { ...preview, result: previewResponse(undefined, { ...entry.publishedVersion, digest: "b".repeat(64) }) }), undefined);
  assert.equal(m.workflowTemplateCreateRequest(session, "channel", "Objective", undefined), undefined);
  assert.equal(m.workflowTemplateIsConflict({ code: "workflow_template_revision_conflict" }), true);
  assert.equal(m.workflowTemplateIsConflict({ status: 409 }), true);
  assert.equal(m.workflowTemplateIsConflict(new Error("network")), false);
});

async function controllerHarness(t, { status = "draft", overrides = {}, active = true } = {}) {
  const port = catalogHookPort();
  const calls = [];
  const saved = records(status);
  const api = {
    listWorkflowTemplates: async cwd => ({ cwd, templates: [saved.entry] }),
    getWorkflowTemplateVersion: async () => ({ entry: saved.entry, version: saved.version }),
    saveWorkflowTemplateVersion: async (_cwd, input) => {
      assert.equal(input.expectedRevision, input.id === saved.entry.id ? saved.entry.revision : 0);
      saved.entry = { ...saved.entry, id: input.id, revision: saved.entry.revision + 1, reviewStatus: "draft", latestVersion: input.version };
      saved.version = { ...saved.version, id: input.id, version: input.version, template: input.template };
      return { entry: saved.entry, version: saved.version };
    },
    setWorkflowTemplateReviewStatus: async (_cwd, _id, input) => {
      assert.equal(input.expectedRevision, saved.entry.revision);
      saved.entry = { ...saved.entry, reviewStatus: input.reviewStatus, revision: saved.entry.revision + 1,
        ...(input.reviewStatus === "published" ? { publishedVersion: { id: saved.entry.id, version: input.version, digest: input.digest } } : {}) };
      return { entry: saved.entry };
    },
    previewWorkflowTemplate: async (_cwd, input) => previewResponse(input.customTemplate ?? saved.version.template,
      input.customTemplate ? { id: input.customTemplate.id, version: "inline", digest } : saved.entry.publishedVersion),
    createChannelWorkflowFromTemplate: async () => ({ workflow: { id: "created-workflow" } }),
    ...overrides,
  };
  const wrapped = Object.fromEntries(Object.entries(api).map(([name, callback]) => [name, (...args) => { calls.push({ name, args }); return callback(...args); }]));
  const h = await catalogConsumerHarness(t, {
    exports: { [controllerPath]: ["useWorkflowTemplateAuthoringController"] }, ports: { hooks: port.hooks, api: wrapped },
    transforms: {
      [modelPath]: [modelTransform],
      [controllerPath]: [
        { anchor: 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
          replace: key => `const { useCallback, useEffect, useMemo, useRef, useState } = globalThis[${jsonStringLiteralForGeneratedSource(key)}].ports.hooks;` },
        { anchor: 'import { createChannelWorkflowFromTemplate } from "../../api/channels.js";',
          replace: key => `const createChannelWorkflowFromTemplate = (...args) => globalThis[${jsonStringLiteralForGeneratedSource(key)}].ports.api.createChannelWorkflowFromTemplate(...args);` },
        { anchor: `import {\n${apiNames.map(name => `  ${name},`).join("\n")}\n} from "../../api/workflow-templates.js";`,
          replace: key => apiNames.map(name => `const ${name} = (...args) => globalThis[${jsonStringLiteralForGeneratedSource(key)}].ports.api.${name}(...args);`).join("\n") },
      ],
    },
  });
  const events = new Map();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name, callback) => { if (events.get(name) === callback) events.delete(name); },
  } });
  t.after(() => { port.unmount(); if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window; });
  const props = { cwd: "/isolated/authoring", active, refreshToken: 0, t: h.state.t, onSuccess: message => calls.push({ name: "toast", message }) };
  const render = () => port.render(h.module.useWorkflowTemplateAuthoringController, props);
  const flush = async () => { await port.flush(); return render(); };
  render();
  await flush();
  return { h, port, api, calls, events, saved, props, render, flush };
}
async function loadEntry(f) {
  f.render().selectEntry(f.saved.entry);
  return f.flush();
}
function editName(f, name = "Changed template") {
  const c = f.render();
  c.setDraft({ ...c.session.draft, template: { ...c.session.draft.template, name } });
  return f.render();
}

test("actual authoring controller loads including archived only when active and workspace changes discard stale results", async t => {
  let resolve;
  const f = await controllerHarness(t, { active: false, overrides: { listWorkflowTemplates: cwd => new Promise(done => { resolve = () => done({ cwd, templates: [records().entry] }); }) } });
  assert.equal(f.calls.length, 0);
  f.props.active = true;
  f.render(); await f.flush();
  assert.deepEqual(f.calls[0], { name: "listWorkflowTemplates", args: ["/isolated/authoring", { includeArchived: true }] });
  const resolveOld = resolve;
  f.props.cwd = "/isolated/other";
  f.render(); await f.flush();
  resolveOld(); await f.flush();
  assert.deepEqual(f.render().entries, []);
  assert.equal(f.render().session, undefined);
  resolve(); await f.flush();
  assert.equal(f.render().entries[0].id, records().entry.id);
});

test("actual authoring controller preserves drafts on save/review CAS conflicts and confirms reload/discard", async t => {
  const conflict = () => { throw Object.assign(new Error("revision conflict"), { status: 409 }); };
  const f = await controllerHarness(t, { overrides: { saveWorkflowTemplateVersion: conflict } });
  await loadEntry(f);
  let c = editName(f);
  await c.save(); c = await f.flush();
  assert.equal(c.session.conflict, true);
  assert.equal(c.session.draft.template.name, "Changed template");
  assert.equal(c.dirty, true);
  assert.equal(c.canCreate, false);
  assert.match(c.error, /Reload/u);
  const calls = f.calls.filter(call => call.name === "saveWorkflowTemplateVersion");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1].expectedRevision, 1);
  assert.equal(calls[0].args[1].version, "2");
  c = editName(f, "Still preserved");
  assert.equal(c.session.conflict, true);
  await c.save();
  assert.equal(f.calls.filter(call => call.name === "saveWorkflowTemplateVersion").length, 1);
  c.reloadLatest(); c = f.render();
  assert.equal(c.discardConfirmation, true);
  c.continueEditing(); assert.equal(f.render().session.draft.template.name, "Still preserved");
  f.render().reloadLatest(); f.render().confirmDiscard(); await f.flush(); c = await f.flush();
  assert.equal(c.session.conflict, false);
  assert.equal(c.session.draft.template.name, baseTemplate().name);
  assert.equal(c.dirty, false);
});

test("actual authoring controller guards subsection/close/new/import transitions and beforeunload", async t => {
  const f = await controllerHarness(t);
  await loadEntry(f);
  editName(f); await f.flush();
  let moved = false;
  f.render().requestLeave(() => { moved = true; });
  assert.equal(moved, false);
  assert.equal(f.render().discardConfirmation, true);
  f.render().continueEditing();
  assert.equal(f.render().dirty, true);
  let prevented = false;
  f.events.get("beforeunload")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  f.render().requestLeave(() => { moved = true; }); f.render().confirmDiscard();
  assert.equal(moved, true);
  assert.equal(f.render().dirty, false);
  editName(f); f.render().closeEditor();
  assert.equal(f.render().discardConfirmation, true);
  f.render().continueEditing();
  f.render().newTemplate(); f.render().confirmDiscard();
  assert.equal(f.render().session.draft.template.autoStartDefault, false);
  await f.render().importFile({ size: 100, text: async () => JSON.stringify(baseTemplate()) });
  assert.equal(f.render().session.draft.template.id, baseTemplate().id);
  assert.equal(f.render().dirty, true);
  f.render().closeEditor(); f.render().confirmDiscard(); f.render(); await f.flush();
  assert.equal(f.render().session, undefined);
  assert.equal(f.events.has("beforeunload"), false);
});

test("actual authoring controller saves immutable next version, publishes its exact pin and creates manually once", async t => {
  const f = await controllerHarness(t);
  await loadEntry(f); editName(f);
  await f.render().save(); let c = await f.flush();
  assert.equal(c.dirty, false);
  assert.equal(c.session.savedVersion.version, "2");
  assert.equal(c.session.draft.version, "3");
  await c.review("published"); c = await f.flush();
  const reviewCall = f.calls.find(call => call.name === "setWorkflowTemplateReviewStatus");
  assert.deepEqual(reviewCall.args, [f.props.cwd, baseTemplate().id, { expectedRevision: 2, reviewStatus: "published", version: "2", digest }]);
  c.setChannelId("channel"); f.render().setObjective(" Objective ");
  await f.render().compilePreview(); c = await f.flush();
  assert.equal(c.canCreate, true);
  assert.deepEqual(f.calls.find(call => call.name === "previewWorkflowTemplate").args, [f.props.cwd, {
    channelId: "channel", objective: "Objective", customTemplateId: baseTemplate().id, customTemplateVersion: "2", customTemplateDigest: digest,
  }]);
  await Promise.all([c.createWorkflow(), c.createWorkflow()]); c = await f.flush();
  assert.equal(c.createdWorkflowId, "created-workflow");
  assert.equal(c.canCreate, false);
  await c.createWorkflow();
  const creates = f.calls.filter(call => call.name === "createChannelWorkflowFromTemplate");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].args, [f.props.cwd, "channel", { objective: "Objective", customTemplateId: baseTemplate().id, customTemplateVersion: "2", customTemplateDigest: digest, autoStart: false }]);
  assert.equal(f.calls.some(call => /orchestrat/iu.test(call.name)), false);
});

test("actual draft preview uses inline data; disabled/archive and edits invalidate creation", async t => {
  const f = await controllerHarness(t);
  await loadEntry(f);
  f.render().setChannelId("channel"); f.render().setObjective("Objective");
  await f.render().compilePreview(); let c = await f.flush();
  assert.deepEqual(f.calls.find(call => call.name === "previewWorkflowTemplate").args[1].customTemplate, baseTemplate());
  assert.equal(c.canCreate, false);
  await c.review("published"); await f.flush();
  await f.render().compilePreview(); c = await f.flush();
  assert.equal(c.canCreate, true);
  editName(f);
  assert.equal(f.render().preview, undefined);
  assert.equal(f.render().canCreate, false);
  f.render().requestLeave(() => {}); f.render().confirmDiscard();
  for (const status of ["disabled", "archived"]) {
    await f.render().review(status); c = await f.flush();
    assert.equal(c.session.entry.reviewStatus, status);
    assert.equal(c.preview, undefined);
    assert.equal(c.canCreate, false);
    const request = f.calls.filter(call => call.name === "setWorkflowTemplateReviewStatus").at(-1).args[2];
    assert.deepEqual(Object.keys(request).sort(), ["expectedRevision", "reviewStatus"]);
  }
});

test("late previews, loads and saves never publish into another workspace or a changed objective", async t => {
  let resolvePreview, resolveLoad, resolveSave;
  const f = await controllerHarness(t, { status: "published", overrides: {
    previewWorkflowTemplate: () => new Promise(done => { resolvePreview = () => done(previewResponse()); }),
    getWorkflowTemplateVersion: () => new Promise(done => { resolveLoad = () => done(records("published")); }),
    saveWorkflowTemplateVersion: () => new Promise(done => { resolveSave = () => done(records()); }),
  } });
  f.render().selectEntry(f.saved.entry); await f.flush(); resolveLoad(); await f.flush();
  f.render().setChannelId("channel"); f.render().setObjective("Objective");
  const previewing = f.render().compilePreview();
  f.render().setObjective("Changed objective"); f.render();
  resolvePreview(); await previewing; await f.flush();
  assert.equal(f.render().preview, undefined);
  editName(f); const saving = f.render().save();
  f.props.cwd = "/isolated/other"; f.render(); await f.flush();
  resolveSave(); await saving; await f.flush();
  assert.equal(f.render().session, undefined);
  f.render().selectEntry(f.saved.entry); await f.flush();
  f.props.cwd = "/isolated/third"; f.render(); await f.flush();
  resolveLoad(); await f.flush();
  assert.equal(f.render().session, undefined);
});

test("failed review preserves exact saved draft and import errors leave the current session intact", async t => {
  const f = await controllerHarness(t, { overrides: { setWorkflowTemplateReviewStatus: async () => { throw Object.assign(new Error("conflict"), { code: "workflow_template_revision_conflict" }); } } });
  await loadEntry(f);
  await f.render().review("published"); await f.flush();
  assert.equal(f.render().session.conflict, true);
  assert.equal(f.render().session.savedVersion.version, "1");
  await f.render().importFile({ size: 10, text: async () => "not JSON" });
  assert.equal(f.render().session.draft.template.id, baseTemplate().id);
  assert.equal(f.render().session.conflict, true);
});

test("authoring JSON export downloads the validated draft and releases its blob URL", async t => {
  const f = await controllerHarness(t);
  await loadEntry(f);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const downloads = [], blobs = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(tag) {
      assert.equal(tag, "a");
      return { click() { downloads.push({ href: this.href, download: this.download }); } };
    },
  } });
  t.after(() => { if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document; });
  t.mock.method(URL, "createObjectURL", blob => { blobs.push(blob); return "blob:authoring-export"; });
  let finishRevoke;
  const revoked = new Promise(done => { finishRevoke = done; });
  t.mock.method(URL, "revokeObjectURL", url => { assert.equal(url, "blob:authoring-export"); finishRevoke(); });
  f.render().exportJson();
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, "application/json");
  assert.deepEqual(JSON.parse(await blobs[0].text()), baseTemplate());
  assert.deepEqual(downloads, [{ href: "blob:authoring-export", download: "authoring-sample.json" }]);
  await revoked;
});

test("actual source components render structured controls, resolved safety and no enabled create for a draft", async t => {
  const { entry, version } = records();
  const h = await catalogConsumerHarness(t, { exports: {
    [modelPath]: ["workflowTemplateSessionFromVersion"],
    "features/settings/WorkflowTemplateEditor.tsx": ["WorkflowTemplateEditor"],
    "features/settings/WorkflowTemplateList.tsx": ["WorkflowTemplateList"],
    "features/settings/SkillLibraryNavigation.tsx": ["SkillLibraryNavigation"],
  }, transforms: { [modelPath]: [modelTransform] } });
  const noop = () => {};
  const controller = { session: h.module.workflowTemplateSessionFromVersion(entry, version), busy: "", dirty: false, error: "",
    validation: { template: baseTemplate(), error: "" }, channelId: "channel", objective: "Objective", canCreate: false,
    preview: { result: previewResponse() }, ...Object.fromEntries(["setDraft", "closeEditor", "exportJson", "reloadLatest", "save", "review", "setChannelId", "setObjective", "compilePreview", "createWorkflow"].map(name => [name, noop])) };
  const markup = h.render(h.module.WorkflowTemplateEditor, { controller, channels: [{ id: "channel", name: "Fixture channel", status: "active" }], teammates: [
    { id: "member-left", displayName: "Inspector", status: "active" }, { id: "member-right", displayName: "Verifier", status: "active" },
  ], t: h.state.t });
  for (const label of ["Template name", "Prompt", "Depends on", "Side-effect class", "Parallel sibling limit", "Resource keys", "Pre-approval", "Post-approval", "Auto-start by default", "Compile preview", "Create workflow"]) assert.ok(markup.includes(label), label);
  assert.ok(markup.includes("artifact:tests"));
  assert.ok(markup.includes("loopback-provider"));
  const createButton = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].map(match => match[0]).find(button => button.includes("Create workflow"));
  assert.ok(createButton, "Create workflow button is rendered");
  assert.match(createButton, /<button\b[^>]*\bdisabled=""/u);
  for (const state of [
    { ...controller, busy: "saving" },
    { ...controller, session: { ...controller.session, entry: { ...entry, source: "builtin", reviewStatus: "builtin" } } },
  ]) {
    const readOnly = h.render(h.module.WorkflowTemplateEditor, { controller: state, channels: [], teammates: [], t: h.state.t });
    const saveButton = [...readOnly.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].map(match => match[0]).find(button => button.includes("Save draft"));
    assert.ok(saveButton);
    assert.match(saveButton, /<button\b[^>]*\bdisabled=""/u);
    const templateFields = readOnly.slice(0, readOnly.indexOf('class="workflow-template-preview'));
    const inputs = [...templateFields.matchAll(/<(?:input|textarea)\b[^>]*>/gu)].map(match => match[0]);
    assert.ok(inputs.length > 0);
    assert.ok(inputs.every(input => /\bdisabled=""/u.test(input)), "busy and built-in authoring fields are read-only");
  }
  const list = h.render(h.module.WorkflowTemplateList, { entries: [entry, { ...entry, id: "disabled-template", reviewStatus: "disabled" }, { ...entry, id: "archived-template", reviewStatus: "archived" }], loading: false, disabled: false, onSelect: noop, t: h.state.t });
  assert.ok(list.includes("disabled-template")); assert.ok(list.includes("archived-template"));
  const nav = h.render(h.module.SkillLibraryNavigation, { activeSection: "workflow-templates", currentUserCount: 0, evolutionCount: 0, builtinCount: 0, onSectionChange: noop });
  assert.ok(nav.includes("Workflow templates"));
});
