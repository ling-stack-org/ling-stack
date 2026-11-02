import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest, workflowIsolationSafetyFingerprint }
  from "../../core/dist/workflow-isolation.js";
import { createWorkflowIntegrationCandidate } from "../dist/features/channels/workflow-integration-candidate.js";
import { workflowGitPacketDigest, workflowGitPacketJson, workflowGitResultRef }
  from "../dist/features/channels/workflow-branch-result.js";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { workflowGitRepositoryBasisDigest } from "../dist/features/workspaces/workflow-git-repository.js";
import { nativeGit, resultJournal, workflowGitResultsFixture } from "./support/workflow-git-results-fixture.mjs";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const defaultSteps = [
  { id: "step-a", position: 1, files: { "owned.txt": "branch a\n" } },
  { id: "step-b", position: 2, files: { "new.txt": "branch b\n" } },
];

async function fixture(t, options = {}) {
  const f = await workflowGitResultsFixture(t, options), steps = options.steps ?? defaultSteps, branches = [];
  for (const step of steps) {
    const branch = await f.branch(step.id, Object.keys(step.files));
    for (const [path, bytes] of Object.entries(step.files)) {
      await mkdir(dirname(join(branch.scope.executionRoot, path)), { recursive: true });
      await writeFile(join(branch.scope.executionRoot, path), bytes);
    }
    branch.terminal.outcome = step.outcome ?? "succeeded";
    branch.terminal.validations[0].exitCode = step.validationExitCode ?? 0;
    branches.push({ ...branch, result: await branch.capture() });
  }
  const integration = await f.branch("integration", []);
  const participants = steps.map(step => ({ workflowStepId: step.id, position: step.position, required: step.required ?? true }));
  const safetyPins = steps.map(step => ({ workflowStepId: step.id, fingerprint: `safety-${step.id}` }));
  const inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: "workflow-one", canonicalWorkspaceId: "workspace-one",
    canonicalWorkspaceRoot: f.root, repositoryIdentity: { commonDir: f.repository.commonDir, objectFormat: "sha1" },
    target: { executionRoot: f.root, worktreeId: "target-one", branchRef: f.repository.branchRef, expectedHead: f.repository.head,
      cleanStateDigest: workflowGitRepositoryBasisDigest(f.repository), inputMode: options.inputMode ?? "clean_checkout" },
    baseCommit: f.repository.head, integration: { executionRoot: integration.scope.executionRoot,
      worktreeId: integration.scope.worktreeId, branchRef: integration.scope.branchRef }, graphFingerprint: "graph-one",
    safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), safetyPins, templatePins: [], participants,
    mergeOrder: participants.slice().sort((a, b) => a.position - b.position || compare(a.workflowStepId, b.workflowStepId)).map(step => step.workflowStepId),
    optionalFailurePolicy: options.optionalFailurePolicy ?? "require_success",
    validationRequirements: [{ id: "integration-test", fingerprint: "integration-test-one" }], mode: options.mode ?? "candidate_only" });
  assert.ok(inputs);
  const writer = { bindingId: integration.lineage.bindingId, workUnitId: integration.lineage.workUnitId,
    attemptId: integration.lineage.attemptId, runtimeInstanceId: integration.lineage.runtimeInstanceId, fencingToken: integration.lineage.fencingToken };
  const context = { roundId: "round-one", generation: 1, inputs, inputsDigest: workflowIntegrationRoundInputsDigest(inputs), writer,
    repository: f.repository, integrationScope: integration.scope, integrationReceipt: integration.receipt,
    branchResults: branches.map(branch => branch.result) };
  const authorityChecks = [], journal = resultJournal();
  const assertCurrentAuthority = async current => {
    authorityChecks.push(current);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.inputs), true);
    assert.equal(current.inputsDigest, context.inputsDigest, "persisted round inputs changed");
    assert.deepEqual(current.writer, writer, "persisted writer changed");
    assert.deepEqual(current.branchResults.map(result => result.packetDigest).sort(), branches.map(branch => branch.result.packetDigest).sort(),
      "closed result set changed");
  };
  const prefix = `refs/ling/workflow/candidates/round-one/1-${integration.scope.worktreeId}`;
  const create = overrides => createWorkflowIntegrationCandidate({ ...context, assertCurrentAuthority, journal, ...overrides });
  const refs = () => f.git("for-each-ref", "--format=%(refname) %(objectname)", `${prefix}/`);
  return { ...f, branches, integration, context, authorityChecks, assertCurrentAuthority, journal, prefix, create, refs };
}

async function checkoutSnapshot(root) {
  const read = async args => (await workflowGit(root, args)).stdout;
  const gitDir = (await read(["rev-parse", "--absolute-git-dir"])).toString().trim();
  return { head: await read(["rev-parse", "HEAD"]), branch: await read(["symbolic-ref", "HEAD"]),
    index: await readFile(join(gitDir, "index")), status: await read(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
    diff: await read(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"]) };
}

async function checkoutSnapshots(f) {
  return Promise.all([f.root, f.integration.scope.executionRoot, ...f.branches.map(branch => branch.scope.executionRoot)].map(checkoutSnapshot));
}

function assertNoEffects(f) {
  assert.deepEqual(f.journal.merges, []);
  assert.deepEqual(f.journal.intents, []);
  assert.deepEqual(f.journal.receipts, []);
}

test("actual merge-tree follows frozen position/id order, seals cumulative evidence and never changes checkouts", nativeGit, async t => {
  const f = await fixture(t, { steps: [
    { id: "step-z", position: 1, files: { "z.txt": "z\n" } },
    { id: "step-a", position: 2, files: { "a.txt": "a\n" } },
    { id: "step-b", position: 1, files: { "b.txt": "b\n" } },
  ] });
  const before = await checkoutSnapshots(f), result = await f.create({ branchResults: f.context.branchResults.slice().reverse() });
  assert.equal(result.status, "pending_verification");
  assert.equal(result.applied, false);
  assert.equal(result.packet.applied, false);
  assert.equal(result.packetDigest, workflowGitPacketDigest(result.packet));
  assert.deepEqual(result.packet.includedStepIds, ["step-b", "step-z", "step-a"]);
  assert.deepEqual(result.packet.context.branchResults.map(branch => branch.packet.context.scope.stepId), ["step-b", "step-z", "step-a"]);
  assert.deepEqual(result.packet.merges.map(merge => merge.workflowStepId), result.packet.includedStepIds);
  assert.deepEqual(result.packet.excludedResults, []);
  assert.equal(result.resultRef, `${f.prefix}/candidate`);
  assert.equal(await workflowGitResultRef(f.root, result.resultRef), result.commit);
  assert.equal(await f.git("rev-parse", `${result.commit}^{tree}`), result.tree);
  assert.equal(result.commit, result.packet.merges.at(-1).commit);
  let previous = f.repository.head;
  for (const [index, merge] of result.packet.merges.entries()) {
    assert.equal(merge.exitCode, 0);
    assert.equal(merge.sequence, index + 1);
    assert.equal(merge.baseCommit, f.repository.head);
    assert.equal(merge.oursCommit, previous);
    assert.equal(merge.theirsCommit, f.branches.find(branch => branch.scope.stepId === merge.workflowStepId).result.commit);
    assert.equal(merge.rawOutputDigest, sha256(merge.rawOutput));
    assert.equal(merge.patchDigest, sha256(merge.patch));
    assert.equal(await workflowGitResultRef(f.root, merge.resultRef), merge.commit);
    assert.deepEqual((await f.git("rev-list", "--parents", "-n", "1", merge.commit)).split(" "), [merge.commit, previous, merge.theirsCommit]);
    assert.equal(f.journal.merges[index].receipt.outcome, "confirmed");
    previous = merge.commit;
  }
  for (const name of ["a", "b", "z"]) assert.equal((await f.gitAt(f.root, ["show", `${result.commit}:${name}.txt`])).toString(), `${name}\n`);
  assert.equal(f.journal.intents.length, 5);
  assert.equal(f.journal.intents[0].ref, `${f.prefix}/started`);
  assert.equal(f.journal.intents[0].afterCommit, f.repository.head);
  for (const intent of f.journal.intents) {
    assert.equal(intent.beforeCommit, null);
    assert.equal(intent.packetDigest, workflowGitPacketDigest(JSON.parse(intent.packetJson)));
  }
  assert.deepEqual(f.journal.receipts.map(receipt => receipt.outcome), ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed"]);
  assert.ok(f.authorityChecks.length > 3);
  assert.deepEqual(await checkoutSnapshots(f), before);
  await assert.rejects(f.create(), { code: "workflow_integration_generation_requires_reconciliation" });
  assert.equal(f.journal.merges.length, 3);
});

test("actual same-file three-way clean merge combines separated edits against the fixed base", nativeGit, async t => {
  const lines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`), changed = (index, value) => {
    const next = lines.slice(); next[index] = value; return `${next.join("\n")}\n`;
  };
  const f = await fixture(t, { files: { "owned.txt": `${lines.join("\n")}\n` }, steps: [
    { id: "step-b", position: 2, files: { "owned.txt": changed(20, "second branch") } },
    { id: "step-a", position: 1, files: { "owned.txt": changed(2, "first branch") } },
  ] });
  const result = await f.create(), expected = lines.slice(); expected[2] = "first branch"; expected[20] = "second branch";
  assert.equal(result.status, "pending_verification");
  assert.equal((await f.gitAt(f.root, ["show", `${result.commit}:owned.txt`])).toString(), `${expected.join("\n")}\n`);
  assert.deepEqual(result.packet.merges.map(merge => merge.exitCode), [0, 0]);
  assert.deepEqual(result.packet.merges[1].stages, []);
  assert.ok(result.packet.merges[1].messages.some(message => message.type === "Auto-merging" && message.paths.includes("owned.txt")));
  assert.equal(result.packet.merges[1].baseCommit, f.repository.head);
  assert.match(result.packet.patch, /first branch/u);
  assert.match(result.packet.patch, /second branch/u);
});

test("actual text conflict seals base/ours/theirs artifacts, stops before later branches and never applies", nativeGit, async t => {
  const f = await fixture(t, { steps: [
    { id: "step-a", position: 1, files: { "owned.txt": "ours\n" } },
    { id: "step-b", position: 2, files: { "owned.txt": "theirs\n" } },
    { id: "step-c", position: 3, files: { "later.txt": "must not be merged\n" } },
  ] });
  const before = await checkoutSnapshots(f), result = await f.create(), conflict = result.packet.merges.at(-1);
  assert.equal(result.status, "conflicted");
  assert.equal(result.applied, false);
  assert.equal(result.resultRef, `${f.prefix}/conflict`);
  assert.deepEqual(result.packet.includedStepIds, ["step-a", "step-b"]);
  assert.deepEqual(result.packet.merges.map(merge => merge.exitCode), [0, 1]);
  assert.equal(conflict.workflowStepId, "step-b");
  assert.deepEqual(conflict.stages.map(stage => [stage.path, stage.stage]), [["owned.txt", 1], ["owned.txt", 2], ["owned.txt", 3]]);
  for (const [index, text] of ["base\n", "ours\n", "theirs\n"].entries()) {
    assert.equal((await f.gitAt(f.root, ["cat-file", "blob", conflict.stages[index].blob])).toString(), text);
  }
  assert.ok(conflict.messages.some(message => message.type === "CONFLICT (contents)" && message.paths.includes("owned.txt")));
  assert.match(conflict.patch, /<<<<<<<[\s\S]*ours[\s\S]*=======[\s\S]*theirs[\s\S]*>>>>>>>/u);
  assert.equal(conflict.rawOutputDigest, sha256(conflict.rawOutput));
  assert.equal(await workflowGitResultRef(f.root, conflict.resultRef), conflict.commit);
  await assert.rejects(f.gitAt(f.root, ["show", `${result.commit}:later.txt`]));
  assert.equal(f.journal.merges.length, 2);
  assert.equal(f.journal.intents.length, 4);
  assert.deepEqual(await checkoutSnapshots(f), before);
});

for (const [outcome, validationExitCode] of [["failed", 0], ["cancelled", 0], ["succeeded", 2]]) {
  test(`required ${outcome}/${validationExitCode} branch blocks before any merge intent`, nativeGit, async t => {
    const f = await fixture(t, { steps: [defaultSteps[0], { ...defaultSteps[1], outcome, validationExitCode }],
      optionalFailurePolicy: "exclude_failed_with_evidence" });
    await assert.rejects(f.create(), { code: "workflow_integration_unsuccessful_required_branch" });
    assertNoEffects(f);
    assert.equal(await f.refs(), "");
  });
}

for (const [outcome, validationExitCode, reason] of [["failed", 0, "failed"], ["cancelled", 0, "cancelled"], ["succeeded", 1, "validation_failed"]]) {
  test(`optional ${reason} branch is excluded only under the frozen policy with its exact result digest`, nativeGit, async t => {
    const f = await fixture(t, { steps: [defaultSteps[0], { ...defaultSteps[1], required: false, outcome, validationExitCode }],
      optionalFailurePolicy: "exclude_failed_with_evidence" });
    const result = await f.create();
    assert.equal(result.status, "pending_verification");
    assert.deepEqual(result.packet.includedStepIds, ["step-a"]);
    assert.deepEqual(result.packet.excludedResults, [{ workflowStepId: "step-b", packetDigest: f.branches[1].result.packetDigest, reason }]);
    assert.equal(f.journal.merges.length, 1);
    await assert.rejects(f.gitAt(f.root, ["show", `${result.commit}:new.txt`]));
  });
}

test("optional require_success and an entirely excluded result set cannot produce a candidate", nativeGit, async t => {
  for (const allExcluded of [false, true]) await t.test(String(allExcluded), async t => {
    const steps = allExcluded ? [{ ...defaultSteps[0], required: false, outcome: "failed" }]
      : [defaultSteps[0], { ...defaultSteps[1], required: false, outcome: "failed" }];
    const f = await fixture(t, { steps, optionalFailurePolicy: allExcluded ? "exclude_failed_with_evidence" : "require_success" });
    await assert.rejects(f.create(), { code: allExcluded ? "workflow_integration_no_successful_branch" : "workflow_integration_unsuccessful_required_branch" });
    assertNoEffects(f);
  });
});

test("missing or boolean authority and missing journal callbacks never default to trusted", nativeGit, async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ assertCurrentAuthority: undefined }), { code: "workflow_integration_authority_required" });
  await assert.rejects(f.create({ assertCurrentAuthority: () => true }), { code: "workflow_integration_authority_return_invalid" });
  for (const name of ["recordIntent", "recordReceipt", "recordMergeIntent", "recordMergeReceipt"]) {
    await assert.rejects(f.create({ journal: { ...f.journal, [name]: undefined } }), { code: "workflow_integration_journal_required" });
  }
  assertNoEffects(f);
});

test("tampered frozen inputs, branch set, lineage, packet, scope and sealed ref cannot reach merge intents", nativeGit, async t => {
  const f = await fixture(t), alteredInputs = structuredClone(f.context.inputs);
  alteredInputs.optionalFailurePolicy = "exclude_failed_with_evidence";
  const wrongOrder = structuredClone(f.context.inputs); wrongOrder.mergeOrder.reverse();
  const wrongPacket = structuredClone(f.branches[0].result); wrongPacket.packet.patch = "forged";
  wrongPacket.packetDigest = workflowGitPacketDigest(wrongPacket.packet);
  const wrongLineage = structuredClone(f.branches[0].result); wrongLineage.packet.context.lineage.workflowId = "other-workflow";
  const wrongRound = structuredClone(f.branches[0].result); wrongRound.packet.context.scope.roundId = "other-round";
  for (const overrides of [
    { inputsDigest: "wrong-digest" }, { inputs: alteredInputs }, { inputs: wrongOrder },
    { branchResults: [f.branches[0].result] }, { branchResults: [f.branches[0].result, f.branches[0].result] },
    { branchResults: [wrongPacket, f.branches[1].result] }, { branchResults: [wrongLineage, f.branches[1].result] },
    { branchResults: [wrongRound, f.branches[1].result] },
    { integrationReceipt: { ...f.context.integrationReceipt, rootInode: "0" } },
    { integrationScope: { ...f.context.integrationScope, baseCommit: "0".repeat(40) } },
  ]) await assert.rejects(f.create(overrides));
  await assert.rejects(f.create({ inputs: alteredInputs, inputsDigest: workflowIntegrationRoundInputsDigest(alteredInputs) }), /persisted round inputs changed/u);
  await workflowGit(f.root, ["update-ref", f.branches[0].result.resultRef, f.repository.head, f.branches[0].result.commit]);
  await assert.rejects(f.create(), { code: "workflow_branch_sealed_ref_changed" });
  assertNoEffects(f);
  assert.equal(await f.refs(), "");
});

test("integration scope cannot substitute a path-like worktree identity or a different worktree root", nativeGit, async t => {
  const f = await fixture(t), inputs = structuredClone(f.context.inputs), scope = structuredClone(f.integration.scope);
  inputs.integration.worktreeId = scope.worktreeId = "../foreign";
  await assert.rejects(f.create({ inputs, inputsDigest: workflowIntegrationRoundInputsDigest(inputs), integrationScope: scope,
    integrationReceipt: { ...f.integration.receipt, worktreeId: scope.worktreeId } }), { code: "workflow_integration_scope_mismatch" });
  await assert.rejects(f.create({ integrationScope: { ...f.integration.scope, worktreeRoot: f.base } }), { code: "workflow_integration_scope_mismatch" });
  assertNoEffects(f);
});

test("borrowed inputs are snapshotted before awaiting journal callbacks and cannot reorder or rebind the candidate", nativeGit, async t => {
  const f = await fixture(t), borrowed = structuredClone(f.context), record = f.journal.recordMergeIntent;
  let changed = false;
  f.journal.recordMergeIntent = async effect => {
    assert.equal(Object.isFrozen(effect), true);
    assert.equal(Object.isFrozen(effect.writer), true);
    if (!changed) {
      changed = true;
      borrowed.inputs.mergeOrder.reverse();
      borrowed.inputs.participants[0].required = false;
      borrowed.writer.fencingToken = "foreign-fence";
      borrowed.branchResults.reverse();
    }
    return record(effect);
  };
  const result = await f.create(borrowed);
  assert.deepEqual(result.packet.includedStepIds, ["step-a", "step-b"]);
  assert.deepEqual(result.packet.context.inputs, f.context.inputs);
  assert.deepEqual(result.packet.context.writer, f.context.writer);
  assert.equal(result.applied, false);
});

test("target checkout dirt, HEAD movement and configuration drift are rejected before generation publication", nativeGit, async t => {
  for (const kind of ["dirty", "head", "config"]) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "dirty") await writeFile(join(f.root, "owned.txt"), "target user edit\n");
    if (kind === "head") await f.git("commit", "--allow-empty", "-m", "external target movement");
    if (kind === "config") await f.git("config", "core.quotePath", "false");
    const before = await checkoutSnapshots(f);
    await assert.rejects(f.create(), { code: kind === "dirty" ? "workflow_git_target_dirty" : "workflow_integration_target_basis_changed" });
    assertNoEffects(f);
    assert.equal(await f.refs(), "");
    assert.deepEqual(await checkoutSnapshots(f), before);
  });
});

test("authority revoked after merge intent prevents the physical merge and records a blocked observation", nativeGit, async t => {
  const f = await fixture(t), record = f.journal.recordMergeIntent;
  let revoked = false;
  f.journal.recordMergeIntent = async effect => { const id = await record(effect); revoked = true; return id; };
  await assert.rejects(f.create({ assertCurrentAuthority: async current => {
    await f.assertCurrentAuthority(current);
    if (revoked) throw new Error("round writer revoked");
  } }), error => error.code === "workflow_integration_merge_unconfirmed" && error.cause.message === "round writer revoked");
  assert.equal(f.journal.merges.length, 1);
  assert.equal(f.journal.merges[0].receipt.outcome, "blocked");
  assert.deepEqual(f.journal.intents.map(effect => effect.ref), [`${f.prefix}/started`]);
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/merge-0001`), null);
});

test("a generation fence prevents replay when merge-tree completed but its result-ref journal intent failed", nativeGit, async t => {
  const f = await fixture(t), record = f.journal.recordIntent;
  f.journal.recordIntent = async effect => {
    if (effect.ref.endsWith("/merge-0001")) throw new Error("result ref intent unavailable");
    return record(effect);
  };
  await assert.rejects(f.create(), { code: "workflow_integration_merge_unconfirmed" });
  const mergeIntents = f.journal.merges.length;
  assert.equal(f.journal.merges[0].receipt.outcome, "confirmed");
  await assert.rejects(f.create(), { code: "workflow_integration_generation_requires_reconciliation" });
  assert.equal(f.journal.merges.length, mergeIntents);
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/started`), f.repository.head);
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/merge-0001`), null);
});

for (const phase of ["generation-intent", "generation-receipt", "merge-intent", "merge-ref-intent", "merge-ref-receipt", "merge-receipt", "candidate-intent", "candidate-receipt"]) {
  test(`journal failure at ${phase} cannot report success, roll back or replay a published generation`, nativeGit, async t => {
    const f = await fixture(t), before = await checkoutSnapshots(f);
    const originalIntent = f.journal.recordIntent, originalReceipt = f.journal.recordReceipt;
    if (phase === "merge-intent") f.journal.recordMergeIntent = async () => { throw new Error("merge intent unavailable"); };
    if (["generation-intent", "merge-ref-intent", "candidate-intent"].includes(phase)) f.journal.recordIntent = async effect => {
      if (effect.ref.endsWith({ "generation-intent": "/started", "candidate-intent": "/candidate", "merge-ref-intent": "/merge-0001" }[phase])) {
        throw new Error("ref intent unavailable");
      }
      return originalIntent(effect);
    };
    if (["generation-receipt", "merge-ref-receipt", "candidate-receipt"].includes(phase)) f.journal.recordReceipt = async receipt => {
      if (receipt.effect.ref.endsWith({ "generation-receipt": "/started", "candidate-receipt": "/candidate", "merge-ref-receipt": "/merge-0001" }[phase])) {
        throw new Error("ref receipt unavailable");
      }
      await originalReceipt(receipt);
    };
    if (phase === "merge-receipt") f.journal.recordMergeReceipt = async () => { throw new Error("merge receipt unavailable"); };
    await assert.rejects(f.create());
    assert.deepEqual(await checkoutSnapshots(f), before);
    const refs = await f.refs(), intents = f.journal.intents.length, merges = f.journal.merges.length;
    if (phase === "generation-intent") {
      assert.equal(refs, "");
      assertNoEffects(f);
    } else {
      assert.notEqual(refs, "");
      for (const line of refs.split("\n")) {
        const [ref, commit] = line.split(" ");
        assert.equal(await workflowGitResultRef(f.root, ref), commit);
        assert.ok(f.journal.intents.some(effect => effect.ref === ref && effect.afterCommit === commit));
      }
      await assert.rejects(f.create(), { code: "workflow_integration_generation_requires_reconciliation" });
      assert.equal(await f.refs(), refs);
      assert.equal(f.journal.intents.length, intents);
      assert.equal(f.journal.merges.length, merges);
    }
    if (["merge-ref-intent", "merge-ref-receipt"].includes(phase)) assert.equal(f.journal.merges[0].receipt.outcome, "confirmed");
  });
}

test("merge object and protected ref effects never nest open round intents", nativeGit, async t => {
  const f = await fixture(t), original = { ...f.journal }, events = [];
  let open;
  for (const [intent, receipt, kind] of [["recordIntent", "recordReceipt", "ref"], ["recordMergeIntent", "recordMergeReceipt", "merge"]]) {
    f.journal[intent] = async effect => {
      assert.equal(open, undefined);
      open = { kind, id: await original[intent](effect) };
      events.push(`${kind}:intent`);
      return open.id;
    };
    f.journal[receipt] = async observation => {
      assert.deepEqual(open, { kind, id: observation.intentId });
      await original[receipt](observation);
      events.push(`${kind}:receipt`);
      open = undefined;
    };
  }
  const result = await f.create();
  assert.equal(open, undefined);
  assert.equal(result.commit, result.packet.merges.at(-1).commit);
  assert.deepEqual(events, ["ref:intent", "ref:receipt", "merge:intent", "merge:receipt", "ref:intent", "ref:receipt",
    "merge:intent", "merge:receipt", "ref:intent", "ref:receipt", "ref:intent", "ref:receipt"]);
});

test("a concurrent ref collision is never overwritten or retried as a fresh candidate", nativeGit, async t => {
  const f = await fixture(t), record = f.journal.recordIntent;
  f.journal.recordIntent = async effect => {
    const id = await record(effect);
    if (effect.ref.endsWith("/merge-0001")) await workflowGit(f.root, ["update-ref", effect.ref, f.repository.head]);
    return id;
  };
  await assert.rejects(f.create(), { code: "workflow_integration_merge_unconfirmed" });
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/merge-0001`), f.repository.head);
  assert.equal(f.journal.receipts.find(receipt => receipt.effect.ref.endsWith("/merge-0001")).outcome, "effect_unknown");
  const refs = await f.refs();
  await assert.rejects(f.create(), { code: "workflow_integration_generation_requires_reconciliation" });
  assert.equal(await f.refs(), refs);
  assert.equal(f.journal.merges.length, 1);
});

test("dirty integration worktree and drift after a persisted merge intent block without touching user files", nativeGit, async t => {
  const f = await fixture(t), path = join(f.integration.scope.executionRoot, "owned.txt");
  await writeFile(path, "external edit\n");
  await assert.rejects(f.create(), { code: "workflow_git_target_dirty" });
  assertNoEffects(f);
  await writeFile(path, "base\n");
  const record = f.journal.recordMergeIntent;
  f.journal.recordMergeIntent = async effect => { const id = await record(effect); await writeFile(path, "drift during intent\n"); return id; };
  await assert.rejects(f.create(), error => error.code === "workflow_integration_merge_unconfirmed" && error.cause.code === "workflow_git_target_dirty");
  assert.equal(await readFile(path, "utf8"), "drift during intent\n");
  assert.equal(f.journal.merges[0].receipt.outcome, "blocked");
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/merge-0001`), null);
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/started`), f.repository.head);
});

test("case-ambiguous directory prefixes across sealed branches block before merge intents", nativeGit, async t => {
  const f = await fixture(t, { steps: [
    { id: "step-a", position: 1, files: { "Module/a.txt": "a\n" } },
    { id: "step-b", position: 2, files: { "module/b.txt": "b\n" } },
  ] });
  await assert.rejects(f.create(), { code: "workflow_integration_ambiguous_case_path" });
  assertNoEffects(f);
});

test("a custom merge driver introduced during journal persistence is blocked before it can execute", nativeGit, async t => {
  const f = await fixture(t), record = f.journal.recordMergeIntent;
  f.journal.recordMergeIntent = async effect => {
    const id = await record(effect);
    await f.git("config", "merge.unsafe.driver", `printf driver > '${join(f.base, "driver-ran")}'`);
    return id;
  };
  await assert.rejects(f.create(), error => error.code === "workflow_integration_merge_unconfirmed"
    && error.cause.code === "workflow_git_custom_configuration_unsupported");
  assert.equal(f.journal.merges[0].receipt.outcome, "blocked");
  assert.equal(f.journal.merges[0].receipt.rawOutput, undefined);
  assert.equal(await workflowGitResultRef(f.root, `${f.prefix}/merge-0001`), null);
  await assert.rejects(access(join(f.base, "driver-ran")), { code: "ENOENT" });
});

test("candidate Git plumbing cannot execute repository hooks or claim apply_to_target mode was applied", nativeGit, async t => {
  const f = await fixture(t, { mode: "apply_to_target", configure: async ({ base, git }) => {
    const hooks = join(base, "hooks"); await mkdir(hooks);
    for (const name of ["post-commit", "post-merge", "post-index-change", "reference-transaction"]) {
      const path = join(hooks, name);
      await writeFile(path, `#!/bin/sh\nprintf hook > '${join(base, "hook-ran")}'\n`); await chmod(path, 0o700);
    }
    await git("config", "core.hooksPath", hooks);
  } });
  const result = await f.create();
  assert.equal(result.status, "pending_verification");
  assert.equal(result.applied, false);
  assert.equal(await f.git("rev-parse", "HEAD"), f.repository.head);
  await assert.rejects(access(join(f.base, "hook-ran")), { code: "ENOENT" });
  assert.equal(result.packet.context.inputs.mode, "apply_to_target");
  assert.equal(result.packetDigest, workflowGitPacketDigest(JSON.parse(workflowGitPacketJson(result.packet))));
});
