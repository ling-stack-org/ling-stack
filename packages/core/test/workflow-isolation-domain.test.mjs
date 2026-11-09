import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  workflowIsolationCanonicalJson, workflowIsolationDigest, workflowIsolationIdentity, workflowIsolationRecord,
  workflowIsolationRevision, workflowIsolationTime, workflowIsolationPathsOverlap,
  workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint,
  normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest,
  normalizeWorkflowIsolationScopePlan, workflowIsolationScopePlanDigest,
  normalizeWorkflowIsolationGitIdentity, normalizeWorkflowIntegrationCandidate, canTransitionWorkflowIntegrationRound,
} from "../dist/index.js";

const commit = "1".repeat(40), tree = "2".repeat(40);
function inputs() {
  const safetyPins = [{ workflowStepId: "step-b", fingerprint: "safety-b" }, { workflowStepId: "step-a", fingerprint: "safety-a" }];
  return { schemaVersion: 1, workflowId: "workflow", canonicalWorkspaceId: "workspace", canonicalWorkspaceRoot: "/repo",
    repositoryIdentity: { commonDir: "/repo/.git", objectFormat: "sha1" },
    target: { executionRoot: "/repo", worktreeId: "target", branchRef: "refs/heads/main", expectedHead: commit,
      cleanStateDigest: `wgr1_${"3".repeat(64)}`, inputMode: "clean_checkout" }, baseCommit: commit,
    integration: { executionRoot: "/isolated/integration", worktreeId: "integration", branchRef: "refs/heads/ling/integration" },
    graphFingerprint: "graph", safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), safetyPins,
    templatePins: [{ templateId: "z", version: "1", digest: "z1" }, { templateId: "a", version: "1", digest: "a1" }],
    participants: [{ workflowStepId: "step-b", position: 2, required: false }, { workflowStepId: "step-a", position: 0, required: true }],
    mergeOrder: ["step-a", "step-b"], optionalFailurePolicy: "exclude_failed_with_evidence",
    validationRequirements: [{ id: "typecheck", fingerprint: "typecheck-v1" }, { id: "tests", fingerprint: "tests-v1" }], mode: "candidate_only" };
}
function scope() {
  const round = inputs();
  const fields = { schemaVersion: 1, planId: "plan", workflowId: round.workflowId, workflowStepId: "step-a",
    canonicalWorkspaceId: round.canonicalWorkspaceId, canonicalWorkspaceRoot: round.canonicalWorkspaceRoot,
    repositoryIdentity: round.repositoryIdentity, target: round.target, integrationRoundId: "round", generation: 1, stepGeneration: 1,
    baseCommit: commit, executionRoot: "/isolated/step-a", worktreeId: "step-worktree", branchRef: "refs/heads/ling/step-a",
    graphFingerprint: round.graphFingerprint, safetyFingerprint: "safety-a", templatePins: round.templatePins,
    resourcePlan: { entries: [{ resourceType: "runner", resourceKey: "pi", limit: 1 },
      { resourceType: "provider", resourceKey: "provider", limit: 1 }, { resourceType: "channel_parallel", resourceKey: "channel", limit: 1 }],
    resourceKeys: ["workspace:physical", "workflow:workflow", "port:17449"] } };
  return { ...fields, planDigest: workflowIsolationScopePlanDigest(fields) };
}

test("domain primitives admit bounded identities, exact revisions and canonical ISO time only", () => {
  assert.equal(workflowIsolationRecord({}), true);
  for (const v of [null, [], "record"]) assert.equal(workflowIsolationRecord(v), false);
  assert.equal(workflowIsolationIdentity("host-assigned id"), true);
  for (const v of ["", " leading", "trailing ", "line\nfeed", "null\0", "x".repeat(4097), 1]) assert.equal(workflowIsolationIdentity(v), false);
  for (const v of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(workflowIsolationRevision(v), true);
  for (const v of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) assert.equal(workflowIsolationRevision(v), false);
  assert.equal(workflowIsolationTime("2026-11-02T00:00:00.000Z"), true);
  for (const v of ["2026-11-02", "2026-11-02T00:00:00Z", "2026-11-02T08:00:00.000+08:00", "invalid", null]) assert.equal(workflowIsolationTime(v), false);
});

test("canonical JSON and prefixed SHA256 are stable across key order, not semantic array order", () => {
  const value = { z: [2, { z: false, a: null }], missing: undefined, a: "text" };
  const canonical = '{"a":"text","z":[2,{"a":null,"z":false}]}';
  assert.equal(workflowIsolationCanonicalJson(value), canonical);
  assert.equal(workflowIsolationDigest(value), `wi1_${createHash("sha256").update(canonical).digest("hex")}`);
  assert.equal(workflowIsolationDigest(value, "custom_"), workflowIsolationDigest({ a: "text", z: [2, { a: null, z: false }] }, "custom_"));
  assert.notEqual(workflowIsolationDigest([1, 2]), workflowIsolationDigest([2, 1]));
  for (const v of [NaN, Infinity, undefined, 1n, Symbol("x"), () => 1, [undefined]]) assert.throws(() => workflowIsolationCanonicalJson(v), /non_json_value/);
  let deep = null;
  for (let i = 0; i < 34; i++) deep = { next: deep };
  assert.throws(() => workflowIsolationCanonicalJson(deep), /value_too_deep/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => workflowIsolationCanonicalJson(cycle), /value_too_deep/);
});

test("path overlap uses path components, in both directions", () => {
  for (const pair of [["/repo", "/repo"], ["/repo", "/repo/file"], ["/repo/file", "/repo"], ["/", "/repo"]])
    assert.equal(workflowIsolationPathsOverlap(...pair), true);
  for (const pair of [["/repo", "/repository"], ["/repo/a", "/repo/b"], ["/repo", "/other/repo"]])
    assert.equal(workflowIsolationPathsOverlap(...pair), false);
});

test("round normalization sorts sets, preserves fixed merge order and never mutates caller data", () => {
  const raw = inputs(), original = structuredClone(raw), normalized = normalizeWorkflowIntegrationRoundInputs(raw);
  assert.deepEqual(raw, original);
  assert.deepEqual(normalized.participants.map(p => p.workflowStepId), ["step-a", "step-b"]);
  assert.deepEqual(normalized.safetyPins.map(p => p.workflowStepId), ["step-a", "step-b"]);
  assert.deepEqual(normalized.templatePins.map(p => p.templateId), ["a", "z"]);
  assert.deepEqual(normalized.validationRequirements.map(p => p.id), ["tests", "typecheck"]);
  assert.equal(workflowIntegrationRoundInputsDigest(normalized), workflowIntegrationRoundInputsDigest(raw));
  assert.match(workflowIntegrationRoundInputsDigest(raw), /^wir1_[a-f0-9]{64}$/);
  assert.notEqual(workflowIntegrationRoundInputsDigest({ ...raw, mode: "apply_to_target" }), workflowIntegrationRoundInputsDigest(raw));
});

for (const [name, mutate] of [
  ["base differs from frozen target HEAD", v => { v.baseCommit = tree; }],
  ["object-format mismatch", v => { v.repositoryIdentity.objectFormat = "sha256"; }],
  ["missing safety pin", v => { v.safetyPins.pop(); }],
  ["duplicate safety pin", v => { v.safetyPins.push(v.safetyPins[0]); }],
  ["invented safety pin", v => { v.safetyPins[0].workflowStepId = "not-a-participant"; }],
  ["unverified aggregate safety fingerprint", v => { v.safetyFingerprint = "model-claimed"; }],
  ["duplicate participant", v => { v.participants.push(v.participants[0]); }],
  ["negative position", v => { v.participants[0].position = -1; }],
  ["model-derived merge order", v => { v.mergeOrder.reverse(); }],
  ["missing validation", v => { v.validationRequirements = []; }],
  ["duplicate validation", v => { v.validationRequirements.push(v.validationRequirements[0]); }],
  ["duplicate template version", v => { v.templatePins.push(v.templatePins[0]); }],
  ["target branch reused", v => { v.integration.branchRef = v.target.branchRef; }],
  ["target worktree reused", v => { v.integration.worktreeId = v.target.worktreeId; }],
  ["integration in canonical workspace", v => { v.integration.executionRoot = "/repo/worktree"; }],
  ["integration enclosing canonical workspace", v => { v.integration.executionRoot = "/"; }],
  ["unknown policy", v => { v.optionalFailurePolicy = "silently_ignore"; }],
]) test(`round rejects ${name}`, () => {
  const v = inputs(); mutate(v);
  assert.equal(normalizeWorkflowIntegrationRoundInputs(v), undefined);
  assert.throws(() => workflowIntegrationRoundInputsDigest(v), /round_inputs_invalid/);
});

for (const root of ["relative", "/", "/isolated/", "/isolated//step", "/isolated/../step", "/isolated/./step", "/repo/.git/worktree"])
  test(`scope rejects noncanonical or protected root ${root}`, () => {
    assert.throws(() => workflowIsolationScopePlanDigest({ ...scope(), executionRoot: root }), /scope_plan_invalid/);
  });

for (const ref of ["HEAD", "refs/tags/v1", "refs/heads/", "refs/heads/a.lock", "refs/heads/.hidden", "refs/heads/a..b",
  "refs/heads/a@{b", "refs/heads/a?b", "refs/heads/a b", "refs/heads/a\\b", "refs/heads/a."])
  test(`scope rejects unsafe branch ref ${ref}`, () => {
    assert.throws(() => workflowIsolationScopePlanDigest({ ...scope(), branchRef: ref }), /scope_plan_invalid/);
  });

test("scope digest covers immutable semantic plan and generations, excludes runtime identity", () => {
  const raw = scope(), original = structuredClone(raw), normalized = normalizeWorkflowIsolationScopePlan(raw);
  assert.deepEqual(raw, original);
  assert.match(raw.planDigest, /^wip1_[a-f0-9]{64}$/);
  assert.deepEqual(normalized.resourcePlan.resourceKeys, [...raw.resourcePlan.resourceKeys].sort());
  assert.deepEqual(normalizeWorkflowIsolationScopePlan(normalized), normalized);
  assert.equal(workflowIsolationScopePlanDigest({ ...raw, runId: "not-yet-created", attemptId: "not-yet-created" }), raw.planDigest);
  for (const change of [{ generation: 2 }, { stepGeneration: 2 }, { executionRoot: "/isolated/new-root" },
    { target: { ...raw.target, cleanStateDigest: "host-basis-changed" } }, { graphFingerprint: "changed" }, { safetyFingerprint: "changed" }]) {
    assert.notEqual(workflowIsolationScopePlanDigest({ ...raw, ...change }), raw.planDigest);
    assert.equal(normalizeWorkflowIsolationScopePlan({ ...raw, ...change }), undefined);
  }
  for (const generation of [0, -1, 1.5, "1"]) assert.throws(() => workflowIsolationScopePlanDigest({ ...raw, generation }), /scope_plan_invalid/);
});

for (const [name, mutate] of [
  ["missing provider", v => { v.entries = v.entries.filter(e => e.resourceType !== "provider"); }],
  ["missing runner", v => { v.entries = v.entries.filter(e => e.resourceType !== "runner"); }],
  ["duplicate entry", v => { v.entries.push(v.entries[0]); }],
  ["two provider identities", v => { v.entries.push({ resourceType: "provider", resourceKey: "other", limit: 1 }); }],
  ["invented slot type", v => { v.entries[0].resourceType = "unbounded"; }],
  ["zero limit", v => { v.entries[0].limit = 0; }],
  ["unsafe limit", v => { v.entries[0].limit = 5; }],
  ["duplicate exclusive key", v => { v.resourceKeys.push(v.resourceKeys[0]); }],
  ["invalid exclusive key", v => { v.resourceKeys.push("bad\0key"); }],
]) test(`scope rejects incomplete resource plan: ${name}`, () => {
  const v = scope(); mutate(v.resourcePlan);
  assert.throws(() => workflowIsolationScopePlanDigest(v), /scope_plan_invalid/);
});

test("step safety fingerprint excludes its own plan pin but retains frozen tools, gates and safety plan", () => {
  const step = { metadata: { requestedRunnerId: "pi", requiredTools: ["read"], sideEffectClass: "workspace_write",
    safetyPlan: { digest: "frozen-safety" }, policy: { retryable: true } } };
  const expected = workflowIsolationStepSafetyFingerprint(step);
  assert.equal(workflowIsolationStepSafetyFingerprint({ metadata: { ...step.metadata,
    isolationScopePlan: { planId: "plan", planDigest: "not-a-recursive-input" }, startOwner: { taskId: "runtime" } } }), expected);
  for (const change of [{ requiredTools: ["read", "write"] }, { safetyPlan: { digest: "changed" } },
    { requestedRunnerId: "other" }, { gates: [{ stage: "pre" }] }, { policy: { retryable: false } }])
    assert.notEqual(workflowIsolationStepSafetyFingerprint({ metadata: { ...step.metadata, ...change } }), expected);
});

test("Git identities and candidates validate existence/object format without acquiring FS authority", () => {
  const loc = { executionRoot: "/does-not-exist/step", worktreeId: "step", branchRef: "refs/heads/ling/step", commonDir: "/repo/.git" };
  assert.deepEqual(normalizeWorkflowIsolationGitIdentity({ ...loc, exists: false, headCommit: null }), { ...loc, exists: false, headCommit: null });
  const existing = { ...loc, exists: true, headCommit: commit, tree, cleanStateDigest: "host-only-shape" };
  assert.deepEqual(normalizeWorkflowIsolationGitIdentity(existing), existing);
  for (const change of [{ exists: false }, { headCommit: null }, { headCommit: commit.toUpperCase().replace("1", "G") },
    { tree: "not-a-tree" }, { commonDir: "relative" }]) assert.equal(normalizeWorkflowIsolationGitIdentity({ ...existing, ...change }), undefined);
  assert.equal(normalizeWorkflowIsolationGitIdentity({ ...loc, exists: false, headCommit: null, tree }), undefined);
  const candidate = { commit, tree, packetDigest: "packet", branchResultDigests: ["branch-b", "branch-a"], validationDigest: "tests" };
  assert.deepEqual(normalizeWorkflowIntegrationCandidate(candidate, "sha1"), candidate);
  assert.equal(normalizeWorkflowIntegrationCandidate(candidate, "sha256"), undefined);
  assert.equal(normalizeWorkflowIntegrationCandidate({ ...candidate, branchResultDigests: [] }, "sha1"), undefined);
  assert.equal(normalizeWorkflowIntegrationCandidate({ ...candidate, commit: "A".repeat(40) }, "sha1"), undefined);
  assert.ok(normalizeWorkflowIntegrationCandidate({ ...candidate, commit: "a".repeat(64), tree: "b".repeat(64) }, "sha256"));
});

const transitions = { preparing: ["collecting", "failed", "blocked"], collecting: ["integrating", "failed", "blocked"],
  integrating: ["verifying", "conflicted", "failed", "blocked"], verifying: ["awaiting_approval", "failed", "blocked"],
  awaiting_approval: ["applying", "blocked"], applying: ["applied", "blocked"], applied: [], conflicted: ["blocked"], failed: [], blocked: [] };
for (const [from, allowed] of Object.entries(transitions)) test(`round state machine only permits declared ${from} edges`, () => {
  for (const to of Object.keys(transitions)) assert.equal(canTransitionWorkflowIntegrationRound(from, to), allowed.includes(to), `${from} -> ${to}`);
  assert.equal(canTransitionWorkflowIntegrationRound(from, "model-defined"), false);
});
