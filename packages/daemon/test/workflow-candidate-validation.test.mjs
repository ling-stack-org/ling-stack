import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest, workflowIsolationSafetyFingerprint }
  from "../../core/dist/workflow-isolation.js";
import { WORKFLOW_CANDIDATE_VALIDATORS, WORKFLOW_CANDIDATE_VALIDATION_POLICY, validateWorkflowIntegrationCandidate,
  workflowCandidateValidationRequirementsDigest } from "../dist/features/channels/workflow-candidate-validation.js";
import { createWorkflowIntegrationCandidate } from "../dist/features/channels/workflow-integration-candidate.js";
import { workflowGitPacketDigest, workflowGitPacketJson } from "../dist/features/channels/workflow-branch-result.js";
import { workflowGit } from "../dist/features/workspaces/managed-worktrees.js";
import { workflowGitRepositoryBasisDigest } from "../dist/features/workspaces/workflow-git-repository.js";
import { nativeGit, resultJournal, workflowGitResultsFixture } from "./support/workflow-git-results-fixture.mjs";

const requirements = Object.freeze(WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => Object.freeze({ id, fingerprint })));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const defaultSteps = [{ id: "step-a", files: { "config.json": '{"candidate":true}\n', "owned.txt": "candidate text\n" } }];

async function fixture(t, options = {}) {
  const f = await workflowGitResultsFixture(t, { ...options,
    files: { "config.json": '{"base":true}\n', "unchanged.json": "not valid JSON\n", ...options.files } });
  const steps = options.steps ?? defaultSteps, branches = [];
  for (const step of steps) {
    const branch = await f.branch(step.id, Object.keys(step.files));
    for (const [path, text] of Object.entries(step.files)) {
      if (text === null) await rm(join(branch.scope.executionRoot, path));
      else { await mkdir(dirname(join(branch.scope.executionRoot, path)), { recursive: true }); await writeFile(join(branch.scope.executionRoot, path), text); }
    }
    branches.push({ ...branch, result: await branch.capture() });
  }
  const integration = await f.branch("integration", []);
  const participants = steps.map((step, index) => ({ workflowStepId: step.id, position: index + 1, required: true }));
  const safetyPins = steps.map(step => ({ workflowStepId: step.id, fingerprint: `safety-${step.id}` }));
  const frozenRequirements = options.requirements ?? requirements;
  const inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: "workflow-one", canonicalWorkspaceId: "workspace-one",
    canonicalWorkspaceRoot: f.root, repositoryIdentity: { commonDir: f.repository.commonDir, objectFormat: "sha1" },
    target: { executionRoot: f.root, worktreeId: "target-one", branchRef: f.repository.branchRef, expectedHead: f.repository.head,
      cleanStateDigest: workflowGitRepositoryBasisDigest(f.repository), inputMode: "clean_checkout" }, baseCommit: f.repository.head,
    integration: { executionRoot: integration.scope.executionRoot, worktreeId: integration.scope.worktreeId, branchRef: integration.scope.branchRef },
    graphFingerprint: "graph-one", safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), safetyPins, templatePins: [], participants,
    mergeOrder: participants.map(step => step.workflowStepId), optionalFailurePolicy: "require_success", validationRequirements: frozenRequirements,
    mode: "candidate_only" });
  assert.ok(inputs);
  const writer = Object.fromEntries(["bindingId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]
    .map(key => [key, integration.lineage[key]]));
  const context = { roundId: "round-one", generation: 1, inputs, inputsDigest: workflowIntegrationRoundInputsDigest(inputs), writer,
    repository: f.repository, integrationScope: integration.scope, integrationReceipt: integration.receipt,
    branchResults: branches.map(branch => branch.result) };
  const candidate = await createWorkflowIntegrationCandidate({ ...context, assertCurrentAuthority: () => {}, journal: resultJournal() });
  assert.equal(candidate.commit, candidate.packet.merges.at(-1).commit);
  assert.equal(candidate.tree, candidate.packet.merges.at(-1).tree);
  const authorityChecks = [];
  const assertCurrentAuthority = async current => {
    authorityChecks.push(current);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.validationRequirements), true);
    assert.equal(Object.isFrozen(current.writer), true);
    assert.equal(current.candidatePacketDigest, candidate.packetDigest, "persisted candidate artifact changed");
    assert.equal(current.inputsDigest, context.inputsDigest, "persisted round inputs changed");
    assert.deepEqual(current.writer, writer, "persisted writer changed");
    assert.deepEqual(current.validationRequirements, inputs.validationRequirements, "persisted requirements changed");
  };
  const validate = overrides => validateWorkflowIntegrationCandidate({ candidate, validationRequirements: frozenRequirements, assertCurrentAuthority, ...overrides });
  return { ...f, context, candidate, integration, branches, authorityChecks, assertCurrentAuthority, validate };
}

async function checkoutSnapshot(root) {
  const read = async args => (await workflowGit(root, args)).stdout;
  const gitDir = (await read(["rev-parse", "--absolute-git-dir"])).toString().trim();
  return { head: await read(["rev-parse", "HEAD"]), branch: await read(["symbolic-ref", "HEAD"]), index: await readFile(join(gitDir, "index")),
    status: await read(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
    diff: await read(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"]) };
}
async function snapshots(f) {
  return { checkouts: await Promise.all([f.root, f.integration.scope.executionRoot, ...f.branches.map(branch => branch.scope.executionRoot)].map(checkoutSnapshot)),
    refs: await f.git("for-each-ref", "--format=%(refname) %(objectname)"), objects: await f.git("count-objects", "-v") };
}
const resultFor = (result, id) => result.packet.results.find(item => item.id === id);
const payloadFor = (result, id) => JSON.parse(resultFor(result, id).artifact.payload);

test("fixed registry fingerprints are immutable versioned Host pins", () => {
  assert.deepEqual(WORKFLOW_CANDIDATE_VALIDATORS.map(entry => entry.id), ["git-diff-check", "json-syntax"]);
  assert.equal(Object.isFrozen(WORKFLOW_CANDIDATE_VALIDATORS), true);
  for (const entry of WORKFLOW_CANDIDATE_VALIDATORS) {
    assert.equal(Object.isFrozen(entry), true); assert.equal(entry.version, 1);
    assert.match(entry.fingerprint, /^wcv1_[a-f0-9]{64}$/u); assert.equal(entry.scope, "candidate_tree_static_checks");
  }
  assert.notEqual(requirements[0].fingerprint, requirements[1].fingerprint);
  assert.equal(workflowCandidateValidationRequirementsDigest(requirements.slice().reverse()), workflowCandidateValidationRequirementsDigest(requirements));
});

test("real candidate checks produce sealed static evidence without hooks, scripts, checkout, index, ref or object writes", nativeGit, async t => {
  let marker;
  const f = await fixture(t, { files: { "package.json": '{"scripts":{"test":"touch forbidden-script-effect"}}\n' },
    configure: async ({ root, base }) => {
      marker = join(base, "forbidden-hook-effect");
      for (const name of ["pre-commit", "post-checkout", "post-merge"]) {
        const path = join(root, ".git", "hooks", name); await writeFile(path, `#!/bin/sh\necho forbidden > '${marker}'\n`); await chmod(path, 0o755);
      }
    } });
  const before = await snapshots(f), result = await f.validate();
  assert.equal(result.status, "passed"); assert.equal(result.applied, false); assert.equal(result.packet.projectTestsRun, false);
  assert.equal(result.packet.kind, "workflow_candidate_verification"); assert.equal(result.packetDigest, workflowGitPacketDigest(result.packet));
  assert.deepEqual(JSON.parse(result.artifact.payload), result.packet); assert.equal(result.artifact.digest, result.packetDigest);
  assert.equal(result.packet.inputsDigest, f.context.inputsDigest); assert.equal(result.packet.candidate.packetDigest, f.candidate.packetDigest);
  assert.equal(result.packet.requirementsDigest, workflowCandidateValidationRequirementsDigest(requirements));
  assert.equal(Object.isFrozen(result.packet.results), true); assert.equal(Object.isFrozen(result.packet.results[0].artifact), true);
  for (const item of result.packet.results) {
    assert.equal(item.status, "passed"); assert.equal(item.executionScope.kind, "candidate_tree_static_checks"); assert.equal(item.executionScope.readOnly, true);
    assert.equal(item.executionScope.executionRoot, f.root); assert.equal(item.executionScope.candidateTree, f.candidate.tree);
    assert.equal(item.artifact.digest, workflowGitPacketDigest(JSON.parse(item.artifact.payload)));
  }
  const json = payloadFor(result, "json-syntax"), diff = payloadFor(result, "git-diff-check");
  assert.equal(json.engine, "JSON.parse"); assert.equal(json.source, "candidate_tree_blobs"); assert.equal(json.filesExamined, 1);
  assert.deepEqual(json.files.map(file => file.path), ["config.json"]); assert.equal(json.files[0].sha256, sha256('{"candidate":true}\n'));
  assert.equal(diff.engine, "host_git"); assert.ok(diff.command.includes("--check")); assert.ok(diff.command.includes("--no-ext-diff"));
  assert.ok(diff.command.includes("--no-textconv")); assert.equal(diff.command.at(-2), f.candidate.tree); assert.equal(diff.exitCode, 0);
  assert.equal(diff.stdout, ""); assert.equal(diff.stderr, ""); assert.ok(f.authorityChecks.length > 20);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(f.root, "forbidden-script-effect")), false);
  assert.deepEqual(await snapshots(f), before);
  const repeated = await f.validate({ assertCurrentAuthority: current => { assert.equal(current.candidatePacketDigest, f.candidate.packetDigest); } });
  assert.equal(repeated.packetDigest, result.packetDigest); assert.deepEqual(await snapshots(f), before);
});

test("invalid JSON comes from candidate blobs, not the clean target or integration checkout", nativeGit, async t => {
  const f = await fixture(t, { steps: [{ id: "step-a", files: { "config.json": '{"broken": ]}\n' } }] });
  const before = await snapshots(f), result = await f.validate(), json = payloadFor(result, "json-syntax");
  assert.equal(result.status, "failed"); assert.equal(resultFor(result, "git-diff-check").status, "passed");
  assert.equal(resultFor(result, "json-syntax").exitCode, 1); assert.equal(json.files[0].status, "failed"); assert.ok(json.files[0].diagnostic.length > 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "config.json"), "utf8")), { base: true });
  assert.deepEqual(JSON.parse(await readFile(join(f.integration.scope.executionRoot, "config.json"), "utf8")), { base: true });
  assert.deepEqual(await snapshots(f), before);
});

test("real git diff --check reports whitespace failure with bounded raw output", nativeGit, async t => {
  const f = await fixture(t, { steps: [{ id: "step-a", files: { "config.json": '{"valid":true}  \n', "owned.txt": "trailing whitespace \n" } }] });
  const before = await snapshots(f), result = await f.validate(), diff = payloadFor(result, "git-diff-check");
  assert.equal(result.status, "failed"); assert.equal(resultFor(result, "json-syntax").status, "passed"); assert.equal(diff.exitCode, 2);
  assert.match(diff.stdout, /trailing whitespace/u); assert.equal(diff.stdoutSha256, sha256(diff.stdout)); assert.deepEqual(await snapshots(f), before);
});

test("deleted JSON is explicit and uppercase JSON is parsed; empty coverage never claims project tests", nativeGit, async t => {
  const f = await fixture(t, { steps: [{ id: "step-a", files: { "config.json": null, "new.JSON": "true\n" } }] });
  const result = await f.validate(), json = payloadFor(result, "json-syntax");
  assert.equal(result.status, "passed"); assert.deepEqual(json.deletedPaths, ["config.json"]); assert.deepEqual(json.files.map(file => file.path), ["new.JSON"]);
  const g = await fixture(t, { steps: [{ id: "step-a", files: { "owned.txt": "ordinary text\n" } }], requirements: [requirements[1]] });
  const empty = await g.validate(); assert.equal(payloadFor(empty, "json-syntax").filesExamined, 0); assert.equal(empty.packet.projectTestsRun, false);
});

test("JSON.parse receives the real UTF-8 BOM instead of silently stripping it", nativeGit, async t => {
  const f = await fixture(t, { steps: [{ id: "step-a", files: { "config.json": Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("{}\n")]) } }] });
  const result = await f.validate(); assert.equal(resultFor(result, "json-syntax").status, "failed");
});

test("unknown, duplicate, extra-command, empty and wrong-fingerprint requirements never default to allowed", nativeGit, async t => {
  const f = await fixture(t), before = await snapshots(f);
  for (const [validationRequirements, code] of [
    [[], "workflow_candidate_validation_requirements_empty"],
    [[{ id: "npm-test", fingerprint: "model-command" }], "workflow_candidate_validation_validator_unknown"],
    [[requirements[0], requirements[0]], "workflow_candidate_validation_requirement_duplicate"],
    [[{ ...requirements[0], fingerprint: "wrong" }], "workflow_candidate_validation_fingerprint_mismatch"],
    [[{ ...requirements[0], command: ["npm", "test"] }], "workflow_candidate_validation_requirement_invalid"],
    [[requirements[0]], "workflow_candidate_validation_requirements_changed"],
  ]) await assert.rejects(f.validate({ validationRequirements }), { code });
  assert.equal(f.authorityChecks.length, 0); assert.deepEqual(await snapshots(f), before);
});

test("an unknown frozen requirement cannot be replaced with known checks", nativeGit, async t => {
  const f = await fixture(t, { requirements: [{ id: "repository-test", fingerprint: "repository-version" }] });
  await assert.rejects(f.validate({ validationRequirements: requirements }), { code: "workflow_candidate_validation_validator_unknown" });
});

test("a real conflicted candidate cannot enter validators", nativeGit, async t => {
  const f = await fixture(t, { steps: [{ id: "step-a", files: { "owned.txt": "ours\n" } }, { id: "step-b", files: { "owned.txt": "theirs\n" } }] });
  assert.equal(f.candidate.status, "conflicted"); const before = await snapshots(f);
  await assert.rejects(f.validate(), { code: "workflow_candidate_validation_candidate_conflicted" });
  assert.equal(f.authorityChecks.length, 0); assert.deepEqual(await snapshots(f), before);
});

test("packet digests, candidate identity, actual patches and merge commit message bindings are rechecked", nativeGit, async t => {
  const f = await fixture(t), before = await snapshots(f);
  const wrongDigest = structuredClone(f.candidate); wrongDigest.packetDigest = `wgp1_${"0".repeat(64)}`;
  await assert.rejects(f.validate({ candidate: wrongDigest }), { code: "workflow_candidate_validation_packet_mismatch" });
  const wrongTree = structuredClone(f.candidate); wrongTree.tree = f.repository.head;
  await assert.rejects(f.validate({ candidate: wrongTree }), { code: "workflow_candidate_validation_packet_mismatch" });
  const wrongPatch = structuredClone(f.candidate); wrongPatch.packet.patch = "forged\n"; wrongPatch.packet.patchDigest = sha256(wrongPatch.packet.patch);
  wrongPatch.packetDigest = workflowGitPacketDigest(wrongPatch.packet);
  await assert.rejects(f.validate({ candidate: wrongPatch, assertCurrentAuthority: () => {} }), { code: "workflow_candidate_validation_patch_mismatch" });
  const wrongMerge = structuredClone(f.candidate); wrongMerge.packet.merges[0].rawOutput += "forged";
  wrongMerge.packet.merges[0].rawOutputDigest = sha256(wrongMerge.packet.merges[0].rawOutput); wrongMerge.packetDigest = workflowGitPacketDigest(wrongMerge.packet);
  await assert.rejects(f.validate({ candidate: wrongMerge, assertCurrentAuthority: () => {} }), { code: "workflow_candidate_validation_commit_mismatch" });
  assert.deepEqual(await snapshots(f), before);
});

test("a cumulative candidate directly references the last merge and every merge retains its message binding", nativeGit, async t => {
  const f = await fixture(t, { steps: [defaultSteps[0], { id: "step-b", files: { "second.json": '{"second":true}\n' } }] });
  const merges = f.candidate.packet.merges, lastMerge = merges.at(-1), before = await snapshots(f);
  assert.equal(merges.length, 2); assert.notEqual(lastMerge.commit, merges[0].commit);
  assert.equal(f.candidate.commit, lastMerge.commit); assert.equal(f.candidate.tree, lastMerge.tree);
  assert.deepEqual((await f.git("rev-list", "--parents", "-n", "1", f.candidate.commit)).split(" "),
    [lastMerge.commit, lastMerge.oursCommit, lastMerge.theirsCommit]);
  const result = await f.validate(); assert.equal(result.status, "passed");
  assert.equal(result.packet.candidate.commit, lastMerge.commit); assert.equal(result.packet.candidate.tree, lastMerge.tree);
  for (const index of [0, 1]) {
    const wrongMerge = structuredClone(f.candidate), merge = wrongMerge.packet.merges[index];
    merge.rawOutput += "forged"; merge.rawOutputDigest = sha256(merge.rawOutput);
    wrongMerge.packetDigest = workflowGitPacketDigest(wrongMerge.packet);
    await assert.rejects(f.validate({ candidate: wrongMerge, assertCurrentAuthority: () => {} }),
      { code: "workflow_candidate_validation_commit_mismatch" });
  }
  assert.deepEqual(await snapshots(f), before);
});

test("a legacy wrapper commit is rejected even with the same tree and the former wrapper message binding", nativeGit, async t => {
  const f = await fixture(t), candidate = structuredClone(f.candidate), packet = candidate.packet;
  const messageDigest = workflowGitPacketDigest({ context: packet.context, merges: packet.merges,
    excludedResults: packet.excludedResults, status: packet.status, tree: packet.tree });
  const wrapper = (await f.gitAt(f.root, ["commit-tree", candidate.tree, "-p", candidate.commit],
    Buffer.from(`Ling workflow integration candidate\n\n${messageDigest}\n`))).toString().trim();
  await f.git("update-ref", candidate.resultRef, wrapper, candidate.commit);
  candidate.commit = wrapper; packet.commit = wrapper; candidate.packetDigest = workflowGitPacketDigest(packet);
  const before = await snapshots(f);
  await assert.rejects(f.validate({ candidate, assertCurrentAuthority: () => {} }),
    { code: "workflow_candidate_validation_commit_mismatch" });
  assert.deepEqual(await snapshots(f), before);
});

test("a direct last-merge candidate still requires the exact merge parents", nativeGit, async t => {
  const f = await fixture(t), candidate = structuredClone(f.candidate), merge = candidate.packet.merges[0];
  const raw = (await f.gitAt(f.root, ["cat-file", "commit", merge.commit])).toString();
  const wrongParents = (await f.gitAt(f.root, ["commit-tree", merge.tree, "-p", merge.oursCommit],
    Buffer.from(raw.slice(raw.indexOf("\n\n") + 2)))).toString().trim();
  await f.git("update-ref", merge.resultRef, wrongParents, merge.commit);
  await f.git("update-ref", candidate.resultRef, wrongParents, candidate.commit);
  merge.commit = wrongParents; candidate.commit = wrongParents; candidate.packet.commit = wrongParents;
  candidate.packetDigest = workflowGitPacketDigest(candidate.packet);
  const before = await snapshots(f);
  await assert.rejects(f.validate({ candidate, assertCurrentAuthority: () => {} }),
    { code: "workflow_candidate_validation_commit_mismatch" });
  assert.deepEqual(await snapshots(f), before);
});

for (const which of ["candidate", "merge", "branch"]) test(`${which} sealed ref drift is rejected without writing a ref back`, nativeGit, async t => {
  const f = await fixture(t), target = which === "candidate" ? f.candidate : which === "merge" ? f.candidate.packet.merges[0] : f.branches[0].result;
  await f.git("update-ref", target.resultRef, f.repository.head, target.commit); const before = await snapshots(f);
  await assert.rejects(f.validate(), { code: "workflow_candidate_validation_ref_changed" }); assert.deepEqual(await snapshots(f), before);
});

for (const drift of ["head", "branch", "config", "integration"]) test(`current ${drift} drift is rejected`, nativeGit, async t => {
  const f = await fixture(t);
  if (drift === "head") await f.git("commit", "--allow-empty", "-m", "foreign HEAD");
  if (drift === "branch") await f.git("switch", "-c", "foreign-branch");
  if (drift === "config") await f.git("config", "user.name", "foreign configuration");
  if (drift === "integration") await writeFile(join(f.integration.scope.executionRoot, "residue.txt"), "foreign\n");
  const before = await snapshots(f);
  await assert.rejects(f.validate(), drift === "integration" ? { code: "workflow_git_target_dirty" } : { code: "workflow_candidate_validation_repository_changed" });
  assert.deepEqual(await snapshots(f), before);
});

test("synchronous/async revocation, invalid returns and cancellation cannot yield failed-or-passed verification", nativeGit, async t => {
  const f = await fixture(t), before = await snapshots(f);
  await assert.rejects(f.validate({ assertCurrentAuthority: undefined }), { code: "workflow_candidate_validation_authority_required" });
  for (const assertCurrentAuthority of [() => true, async () => true]) {
    await assert.rejects(f.validate({ assertCurrentAuthority }), { code: "workflow_candidate_validation_authority_return_invalid" });
  }
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const check = current => { assert.equal(current.candidatePacketDigest, f.candidate.packetDigest); if (++calls >= 8) throw new Error("owner revoked"); };
    await assert.rejects(f.validate({ assertCurrentAuthority: asynchronous ? async current => { await Promise.resolve(); check(current); } : check }), /owner revoked/u);
    assert.ok(calls >= 8, "revocation is rechecked while rejected observations unwind");
  }
  const controller = new AbortController();
  await assert.rejects(f.validate({ signal: controller.signal, assertCurrentAuthority: async () => {
    await Promise.resolve(); controller.abort();
  } }), { code: "workflow_candidate_validation_cancelled" });
  await assert.rejects(f.validate({ signal: controller.signal }), { code: "workflow_candidate_validation_cancelled" });
  assert.deepEqual(await snapshots(f), before);
});

test("candidate and requirements are frozen before an asynchronous authority callback can mutate borrowed input", nativeGit, async t => {
  const f = await fixture(t), borrowed = structuredClone(f.candidate), pins = structuredClone(requirements);
  let changed = false;
  const result = await f.validate({ candidate: borrowed, validationRequirements: pins, assertCurrentAuthority: async current => {
    await f.assertCurrentAuthority(current);
    if (!changed) { changed = true; borrowed.packet.patch = "borrowed mutation"; pins[0].fingerprint = "borrowed mutation"; }
  } });
  assert.equal(result.status, "passed"); assert.equal(result.packet.candidate.packetDigest, f.candidate.packetDigest);
  assert.deepEqual(result.packet.validationRequirements, requirements);
});

test("effective repository whitespace attribute overrides cannot suppress the fixed Host check", nativeGit, async t => {
  const f = await fixture(t, { files: { ".gitattributes": "*.json -whitespace\n" } });
  const before = await snapshots(f);
  await assert.rejects(f.validate(), { code: "workflow_candidate_validation_whitespace_attributes_unsupported" });
  assert.deepEqual(await snapshots(f), before);
});

test("changed JSON count is bounded before parsing any candidate blob", nativeGit, async t => {
  const files = Object.fromEntries(Array.from({ length: WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxJsonFiles + 1 }, (_, index) => [`j-${index}.json`, "{}\n"]));
  const f = await fixture(t, { steps: [{ id: "step-a", files }] });
  const before = await snapshots(f);
  await assert.rejects(f.validate(), { code: "workflow_candidate_validation_json_budget_exceeded" });
  assert.deepEqual(await snapshots(f), before);
});
