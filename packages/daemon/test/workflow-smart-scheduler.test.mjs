import assert from "node:assert/strict";
import test from "node:test";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultSkills } from "../../core/dist/index.js";
import { schedulerFixture, schedulerInput, schedulerModule, beginSchedulerStep, linkSchedulerRun } from "./support/workflow-scheduler-fixture.mjs";

const { resolveSmartSchedulingDecision } = await schedulerModule("smart-scheduler");
const decide = (f, overrides) => resolveSmartSchedulingDecision(schedulerInput(f, overrides));

test("legacy read tool lists and sibling limits never opt into parallel execution", async t => {
  const f = await schedulerFixture(t);
  f.step("Legacy A", { sideEffectClass: undefined, parallelPolicy: undefined, maxParallelSiblings: 3 });
  f.step("Legacy B", { sideEffectClass: undefined, parallelPolicy: undefined, maxParallelSiblings: 3 });
  const result = decide(f);
  assert.equal(result.effectiveMode, "serial");
  assert.equal(result.runnableStepIds.length, 1);
  assert.ok(result.reasonCodes.includes("safety_opt_in_required"));
});

test("explicit readonly opt-in still stays serial without a Host capability callback", async t => {
  const f = await schedulerFixture(t);
  f.step("A"); f.step("B");
  const result = decide(f, { resolveParallelCapability: undefined });
  assert.equal(result.parallelLimit, 1);
  assert.equal(result.runnableStepIds.length, 1);
  assert.ok(result.reasonCodes.includes("host_parallel_capability_unavailable"));
});

for (const [label, metadata] of [
  ["artifact-only", { sideEffectClass: "test_artifact_only", parallelPolicy: {
    autoParallel: true, maxParallelSiblings: 3, requiresArtifactOnly: true } }],
  ["workspace write", { sideEffectClass: "workspace_write" }],
  ["missing opt-in", { parallelPolicy: { autoParallel: false, maxParallelSiblings: 3 } }],
]) {
  test(`${label} cannot run in parallel even when Host returns verified`, async t => {
    const f = await schedulerFixture(t);
    f.step("A", metadata); f.step("B", metadata);
    assert.equal(decide(f).runnableStepIds.length, 1);
    assert.equal(decide(f).effectiveMode, "serial");
  });
}

test("explicit Host-verified analysis branches can fill the available budget", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A"), b = f.step("B");
  const result = decide(f);
  assert.equal(result.effectiveMode, "parallel");
  assert.deepEqual(result.runnableStepIds, [a.id, b.id]);
});

test("channel workflow sibling legacy and Host limits take the minimum", async t => {
  const f = await schedulerFixture(t, { cap: 5, workflowCap: 4 });
  const a = f.step("A", { parallelPolicy: { autoParallel: true, maxParallelSiblings: 4 }, maxParallelSiblings: 3 });
  const b = f.step("B", { parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } });
  const c = f.step("C");
  const result = decide(f, { resolveParallelCapability: () => ({ verified: true, resourceKeys: [], parallelLimit: 3 }) });
  assert.equal(result.parallelLimit, 2);
  assert.deepEqual(result.runnableStepIds, [a.id, b.id]);
  assert.deepEqual(result.queuedStepIds, [c.id]);
});

test("a single queued candidate can share with a verified active executor", async t => {
  const f = await schedulerFixture(t, { cap: 2 });
  const a = f.step("Active"), b = f.step("Queued");
  const run = linkSchedulerRun(f, a, beginSchedulerStep(f, a));
  let observedRun;
  const result = decide(f, { resolveParallelCapability: context => { observedRun ??= context.run; return f.capability(context); } });
  assert.equal(result.parallelLimit, 2);
  assert.deepEqual(result.runnableStepIds, [b.id]);
  assert.equal(observedRun.id, run.id);
});

test("a preparing writer blocks a readonly sibling even when caller count claims zero", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("Preparing writer", { sideEffectClass: "workspace_write", requiredTools: ["write"] });
  f.step("Queued");
  beginSchedulerStep(f, a);
  const result = decide(f, { activeStepCount: 0 });
  assert.deepEqual(result.runnableStepIds, []);
  assert.ok(result.reasonCodes.includes("active_step_safety_unverified"));
});

test("an active executor without verified readonly snapshot blocks new siblings", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("Unverified"); f.step("Queued");
  linkSchedulerRun(f, a, beginSchedulerStep(f, a), {}, false);
  assert.deepEqual(decide(f).runnableStepIds, []);
});

test("a preparing sibling with cap one cannot be widened by a later candidate", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("Narrow", { parallelPolicy: { autoParallel: true, maxParallelSiblings: 1 } });
  f.step("Wide"); beginSchedulerStep(f, a);
  assert.equal(decide(f).parallelLimit, 1);
  assert.deepEqual(decide(f).runnableStepIds, []);
});

test("active and selected Host resources are unioned with declared resources", async t => {
  const f = await schedulerFixture(t);
  const active = f.step("Active", { parallelPolicy: { autoParallel: true, maxParallelSiblings: 3, resourceKeys: ["declared:cache"] } });
  const conflict = f.step("Conflict"), free = f.step("Free");
  beginSchedulerStep(f, active);
  const result = decide(f, { resolveParallelCapability: ({ step }) => ({ verified: true,
    resourceKeys: step.id === conflict.id ? ["declared:cache"] : step.id === active.id ? ["host:index"] : [] }) });
  assert.deepEqual(result.runnableStepIds, [free.id]);
  assert.ok(result.queuedStepIds.includes(conflict.id));
  assert.ok(result.resourceLocks.includes("host:index"));
  assert.ok(result.resourceLocks.includes("declared:cache"));
});

test("resource-conflicting candidates are skipped without freezing a later independent candidate", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A"), b = f.step("B"), c = f.step("C");
  const result = decide(f, { resolveParallelCapability: ({ step }) => ({ verified: true,
    resourceKeys: step.id === c.id ? [] : ["host:shared-build"] }) });
  assert.deepEqual(result.runnableStepIds, [a.id, c.id]);
  assert.deepEqual(result.queuedStepIds, [b.id]);
  assert.ok(result.reasonCodes.includes("resource_conflict"));
});

test("candidate order is position then stable step id, not branch group or input order", async t => {
  const f = await schedulerFixture(t);
  const a = f.step("A", {}, { position: 1 }), b = f.step("B", {}, { position: 1 });
  const sorted = [a, b].sort((x, y) => x.id < y.id ? -1 : 1);
  f.store.updateChannelWorkflowStep(sorted[0].id, { metadata: { ...sorted[0].metadata, branchGroupId: "z" } }, new Date().toISOString());
  f.store.updateChannelWorkflowStep(sorted[1].id, { metadata: { ...sorted[1].metadata, branchGroupId: "a" } }, new Date().toISOString());
  assert.deepEqual(decide(f, { eligibleSteps: f.steps().reverse() }).runnableStepIds, sorted.map(step => step.id));
});

test("step read declaration cannot hide mutation tools required by its skill", async t => {
  const f = await schedulerFixture(t);
  const skill = listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID).find(skill => skill.requiredTools.includes("write"));
  assert.ok(skill);
  f.step("Skill writer", { requiredTools: ["read"], skillId: skill.id }); f.step("Safe");
  const result = decide(f);
  assert.equal(result.runnableStepIds.length, 1);
  assert.equal(result.effectiveMode, "serial");
  assert.ok(result.reasonCodes.includes("side_effectful_step_serial"));
});

test("missing skills fail closed even with an explicit read tool list", async t => {
  const f = await schedulerFixture(t);
  f.step("Missing skill", { skillId: "not-installed" }); f.step("Safe");
  assert.ok(decide(f).reasonCodes.includes("unknown_tools_serial"));
});

test("Host callback sees the union of step and skill tools", async t => {
  const f = await schedulerFixture(t);
  const skill = listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID).find(skill => skill.requiredTools.length > 0
    && skill.requiredTools.every(tool => !["bash", "edit", "write"].includes(tool)));
  assert.ok(skill);
  f.step("Skill reader", { requiredTools: ["find"], skillId: skill.id });
  let observed;
  decide(f, { resolveParallelCapability: context => { observed = context.tools; return f.capability(context); } });
  assert.deepEqual(new Set(observed), new Set(["find", ...skill.requiredTools]));
});

for (const [label, callback] of [
  ["throw", () => { throw new Error("Host unavailable"); }],
  ["unverified", () => ({ verified: false, resourceKeys: [] })],
  ["async result", async () => ({ verified: true, resourceKeys: [] })],
]) {
  test(`Host ${label} cannot accidentally enable parallel scheduling`, async t => {
    const f = await schedulerFixture(t); f.step("A"); f.step("B");
    assert.equal(decide(f, { resolveParallelCapability: callback }).runnableStepIds.length, 1);
  });
}
