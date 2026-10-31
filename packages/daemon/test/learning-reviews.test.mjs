import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { learningFixture } from "./support/learning-review-fixture.mjs";
import { parseLearningDraft } from "../dist/features/learning/extractor.js";
import { captureLearningEvidence, learningEvidenceCurrent } from "../dist/features/learning/evidence.js";
import { LearningReviewCoordinator, commitLearningDraft } from "../dist/features/learning/coordinator.js";
import { executeLearningModel, prepareLearningModelRequest } from "../dist/features/learning/model.js";
const clock = () => new Date().toISOString();

test("learning is off by default, explicit selection is idempotent and policy changes are CAS protected", async t => {
  const f = await learningFixture(t);
  assert.deepEqual(f.store.getLearningReviewPolicy(), { revision: 0, mode: "off" });
  assert.throws(() => f.enqueue("automatic"), /learning_automatic_disabled/);
  const job = f.enqueue(); assert.equal(job.status, "queued");
  assert.equal(f.enqueue().id, job.id);
  const policy = f.store.updateLearningReviewPolicy({ mode: "propose", providerPresetId: "fixture", expectedRevision: 0 }, clock());
  assert.equal(policy.revision, 1); assert.equal(f.enqueue("automatic").id, job.id, "one source never starts two logical jobs");
  assert.throws(() => f.store.updateLearningReviewPolicy({ mode: "off", expectedRevision: 0 }, clock()), /learning_policy_conflict/);
});

test("automatic quota is durable and does not charge explicit saves", async t => {
  const f = await learningFixture(t);
  f.store.updateLearningReviewPolicy({ mode: "propose", providerPresetId: "fixture", expectedRevision: 0 }, clock());
  for (let i = 0; i < 10; i += 1) f.enqueue("automatic", { ...f.evidence, digest: i.toString(16).padStart(64, "0") });
  assert.throws(() => f.enqueue("automatic", { ...f.evidence, digest: "f".repeat(64) }), /learning_daily_quota_exceeded/);
  assert.equal(f.enqueue("explicit", { ...f.evidence, digest: "e".repeat(64) }).status, "queued");
});

test("model budget is reserved before dispatch and a foreign/stopped Attempt cannot commit", async t => {
  const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
  assert.equal(f.store.reserveLearningReviewModelRequest(job.id, fence, 7000, clock()).modelRequests, 1);
  assert.equal(f.store.reserveLearningReviewModelRequest(job.id, fence, 7000, clock()).outputTokensReserved, 4096);
  assert.throws(() => f.store.reserveLearningReviewModelRequest(job.id, fence, 1, clock()), /learning_budget_exceeded/);
  assert.throws(() => f.store.finishLearningReviewJob(job.id, { ...fence, fencingToken: "foreign" }, "succeeded", [], undefined, clock()), /learning_claim_lost/);
  f.store.cancelLearningReviewJob(job.id, "user_cancelled", clock());
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }), /learning_claim_lost/);
  assert.equal(f.store.listSkillCandidates().length, 0);
});

test("workspace limits may lower cumulative budgets but never raise the hard caps", async t => {
  const f = await learningFixture(t);
  const policy = f.store.updateLearningReviewPolicy({ mode: "off", expectedRevision: 0,
    limits: { maxRequests: 1, inputTokens: 5000, outputTokens: 1024, perRequestOutputTokens: 1024,
      timeoutMs: 10000, dailyAutomaticJobs: 2 } }, clock());
  const { job, fence } = f.claim(f.enqueue());
  assert.deepEqual(job.limits, policy.limits);
  assert.throws(() => f.store.reserveLearningReviewModelRequest(job.id, fence, 5001, clock()), /learning_budget_exceeded/);
  const reserved = f.store.reserveLearningReviewModelRequest(job.id, fence, 4000, clock());
  assert.equal(reserved.outputTokensReserved, 1024);
  assert.throws(() => f.store.reserveLearningReviewModelRequest(job.id, fence, 1, clock()), /learning_budget_exceeded/);
  for (const limits of [{ maxRequests: 3 }, { timeoutMs: -1 }, { inputTokens: "1000" }, { unknown: 1 }]) {
    assert.throws(() => f.store.updateLearningReviewPolicy({ mode: "off", expectedRevision: 1, limits }, clock()), /learning_limits_invalid/);
  }
  assert.equal(f.store.getLearningReviewPolicy().revision, 1);
});

test("evidence window is bounded and lineage/failed checks never turn into proof of success", async t => {
  const f = await learningFixture(t, { terminal: "failed" });
  assert.equal(f.evidence.runStatus, "failed");
  assert.ok(Buffer.byteLength(JSON.stringify(f.evidence)) < 32768); assert.ok(f.evidence.items.length <= 64);
  assert.equal(learningEvidenceCurrent(f.store, f.evidence), true);
  assert.throws(() => captureLearningEvidence(f.store, "unknown"), /learning_source_not_terminal/);
  const forged = structuredClone(f.draft); forged.checks[0].evidence = { evidenceId: f.evidence.items[0].id, quote: "Amber" };
  assert.throws(() => parseLearningDraft(JSON.stringify(forged), f.evidence), /learning_evidence_unsupported/);
  f.store.updateTask(f.task.id, { prompt: "Changed source instruction" }, clock());
  assert.equal(learningEvidenceCurrent(f.store, f.evidence), false);
});

test("extractor rejects unsupported citations, missing verification, placeholders and authority fields", async t => {
  const f = await learningFixture(t);
  assert.equal(parseLearningDraft(JSON.stringify(f.draft), f.evidence).kind, "procedure");
  for (const mutate of [
    draft => { draft.steps[0].evidence.quote = "Fabricated evidence"; },
    draft => { draft.steps[0].instruction = "Use bash as part of the observed workflow."; },
    draft => { draft.checks = []; },
    draft => { draft.tools = ["bash"]; },
    draft => { draft.destination = "automation"; },
  ]) { const draft = structuredClone(f.draft); mutate(draft); assert.throws(() => parseLearningDraft(JSON.stringify(draft), f.evidence)); }
  assert.deepEqual(parseLearningDraft('{"kind":"none","reason":"No result evidence"}', f.evidence), { kind: "none", reason: "No result evidence" });
});

test("grounded procedure commits only a pending candidate and one job result, with post-commit events", async t => {
  const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
  const result = commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub });
  assert.equal(result.status, "succeeded"); assert.equal(result.candidateIds.length, 1);
  assert.equal(f.store.getSkillCandidate(result.candidateIds[0]).status, "pending");
  assert.equal(f.store.getSkillRegistryEntry(result.candidateIds[0]), undefined);
  assert.equal(f.published.length, 1);
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }), /learning_claim_lost/);
  assert.equal(f.store.listSkillCandidates().length, 1);
});

test("candidate and learning job roll back together when the final job write fails", async t => {
  const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
  f.database.exec("CREATE TRIGGER fail_learning_finish BEFORE UPDATE ON learning_review_jobs WHEN new.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic finish failure'); END");
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }), /synthetic finish failure/);
  assert.equal(f.store.listSkillCandidates().length, 0); assert.equal(f.store.listProcedureObservations().length, 0);
  assert.equal(f.store.getLearningReviewJob(job.id).status, "running"); assert.equal(f.published.length, 0);
});

test("memory extraction preserves narrow scope and never activates a memory", async t => {
  const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
  const draft = { kind: "memory", title: "Receipt total", body: "Receipt total is 42.", evidence: f.draft.steps[0].evidence };
  const result = commitLearningDraft({ store: f.store, job, fence, draft, hub: f.hub });
  const memory = f.store.getMemoryObject(result.candidateIds[0]);
  assert.equal(memory.reviewState, "candidate"); assert.equal(memory.scopeType, "task");
  assert.equal(memory.ownerId, f.task.id); assert.equal(memory.sensitivity, "normal");
});


test("a concrete correction proposes an existing definition revision without changing its authority", async t => {
  const definition = { id: "amber", name: "Amber", summary: "Reconcile receipts", roleAffinity: ["engineer"],
    promptFragments: ["Read receipt total."], requiredTools: ["read"], requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "strict", risk: "high" }, stateEffects: [] };
  const f = await learningFixture(t, { correction: "Compare the ledger sum as well as the receipt total.", skillDefinition: definition });
  const evidence = captureLearningEvidence(f.store, f.run.id, "Compare the ledger sum as well as the receipt total.");
  const { job, fence } = f.claim(f.enqueue("explicit", evidence));
  const result = commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub });
  const candidate = f.store.getSkillCandidate(result.candidateIds[0]);
  assert.equal(candidate.targetSkillId, definition.id); assert.equal(candidate.proposedAction, "update_existing");
  assert.deepEqual(candidate.definition.skillDefinition.requiredTools, definition.requiredTools);
  assert.deepEqual(candidate.definition.skillDefinition.approvalProfile, definition.approvalProfile);
  assert.deepEqual(f.store.getSkillRegistryEntry(definition.id).definition, definition);
});

test("foreground work defers queued reviews and cancellation fences an uncooperative late model result", async t => {
  const f = await learningFixture(t); const queued = f.enqueue();
  f.supervisor.getRuntime(f.cwd, f.store);
  const foreground = f.store.createWorkUnit({ workspaceId: "workspace_default", kind: "task_run", ownerType: "run", ownerId: "foreground",
    idempotencyKey: "foreground", status: "running", createdByActor: "user", request: {}, now: clock() });
  let calls = 0, release;
  const coordinator = new LearningReviewCoordinator({ runtimeSupervisor: f.supervisor, secretResolver: {}, controlPlaneEvents: f.hub,
    extract: async () => { calls += 1; return new Promise(resolve => { release = () => resolve(f.draft); }); } });
  t.after(async () => { coordinator.beginShutdown(); release?.(); await coordinator.drain(); });
  coordinator.registerStore(f.store);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 0); assert.equal(f.store.getLearningReviewJob(queued.id).status, "queued");
  f.database.prepare("UPDATE work_units SET status = 'succeeded' WHERE id = ?").run(foreground.id);
  coordinator.wake(f.store); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  f.store.cancelLearningReviewJob(queued.id, "user_cancelled", clock());
  release(); await coordinator.drain(); coordinator.beginShutdown();
  assert.equal(f.store.getLearningReviewJob(queued.id).status, "cancelled"); assert.equal(f.store.listSkillCandidates().length, 0);
});

test("one real transport request has an output cap and exposes no executable tool surface", async t => {
  const f = await learningFixture(t); let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests += 1;
    assert.equal(body.max_tokens, 2048); assert.equal(body.tools, undefined); assert.equal(body.stream, false);
    assert.equal(body.messages.length, 2);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(f.draft) } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = prepareLearningModelRequest(f.evidence);
  assert.ok(request.inputTokens < 16000);
  const result = await executeLearningModel({ evidence: f.evidence, prompt: request.prompt, signal: new AbortController().signal,
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false } });
  assert.equal(result.kind, "procedure"); assert.equal(requests, 1);
});


test("channel methods use existing protocol/playbook drafts and never activate or alter overrides", async t => {
  for (const destination of ["channel_protocol", "playbook"]) {
    const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
    const result = commitLearningDraft({ store: f.store, job, fence, draft: { ...f.draft, destination }, hub: f.hub });
    assert.equal(f.store.getChannelCollaborationProtocolOverride(f.channel.id), undefined);
    assert.equal(f.store.listSkillCandidates().length, 0);
    const candidate = destination === "channel_protocol" ? f.store.getChannelCollaborationProtocolDraft(result.candidateIds[0])
      : f.store.getChannelPlaybookCandidate(result.candidateIds[0]);
    assert.equal(candidate.channelId, f.channel.id); assert.equal(candidate.status, "draft");
  }
});

test("a restarted worker cancels an old Attempt rather than dispatching it again", async t => {
  const f = await learningFixture(t); const { job, fence } = f.claim(f.enqueue());
  f.store.reserveLearningReviewModelRequest(job.id, fence, 3000, clock());
  f.supervisor.releaseAll();
  let calls = 0;
  const coordinator = new LearningReviewCoordinator({ runtimeSupervisor: f.supervisor, secretResolver: {}, controlPlaneEvents: f.hub,
    extract: async () => { calls += 1; return f.draft; } });
  coordinator.registerStore(f.store); coordinator.beginShutdown(); await coordinator.drain();
  assert.equal(calls, 0); assert.equal(f.store.getLearningReviewJob(job.id).status, "cancelled");
  assert.equal(f.store.getLearningReviewJob(job.id).modelRequests, 1);
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }));
  assert.equal(f.store.listSkillCandidates().length, 0);
});

test("a transient retry stays within the same durable job and cumulative reservation", async t => {
  const f = await learningFixture(t); const queued = f.enqueue(); let calls = 0;
  const coordinator = new LearningReviewCoordinator({ runtimeSupervisor: f.supervisor, secretResolver: {}, controlPlaneEvents: f.hub,
    extract: async () => { calls += 1; if (calls === 1) throw new Error("learning_provider_http_429");
      return { kind: "none", reason: "No further reusable knowledge" }; } });
  coordinator.registerStore(f.store); await coordinator.drain(); coordinator.beginShutdown();
  const job = f.store.getLearningReviewJob(queued.id);
  assert.equal(calls, 2); assert.equal(job.status, "succeeded"); assert.equal(job.modelRequests, 2);
  assert.ok(job.inputTokensReserved <= 16000); assert.equal(job.outputTokensReserved, 4096);
});

test("policy off while a model is running cancels the automatic job and rejects its late candidate", async t => {
  const f = await learningFixture(t);
  f.store.updateLearningReviewPolicy({ mode: "propose", providerPresetId: "fixture", expectedRevision: 0 }, clock());
  const { job, fence } = f.claim(f.enqueue("automatic"));
  f.store.reserveLearningReviewModelRequest(job.id, fence, 3000, clock());
  f.store.updateLearningReviewPolicy({ mode: "off", expectedRevision: 1 }, clock());
  assert.equal(f.store.getLearningReviewJob(job.id).status, "cancelled");
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }));
  assert.equal(f.store.listSkillCandidates().length, 0);
});

test("daemon HTTP correction completes model, review, revision history and safe undo without replacing skill ownership", async t => {
  const { createSqliteRunStore } = await import("@ling-stack/core");
  const { createDaemonServer } = await import("../dist/index.js");
  const originalDefinition = { id: "amber", name: "Amber", summary: "Reconcile receipts", roleAffinity: ["engineer"],
    promptFragments: ["Read receipt total."], requiredTools: ["read"], requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "none" }, stateEffects: [] };
  const f = await learningFixture(t, { skillDefinition: originalDefinition, skillSourcePath: "receipt/skills.json" }); let requests = 0;
  const original = f.skill;
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).max_tokens, 1024);
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(f.draft) } }] }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "Local learning fixture", providerId: "local-learning",
    model: "fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, authHeader: false,
    reasoning: false, capabilities: ["chat"], enabled: true }, clock());
  f.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Local fixture ready", checkedAt: clock() });
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd },
    { storeFactory: cwd => createSqliteRunStore(cwd) });
  t.after(async () => { await daemon.stop(); await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); });
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.server.address().port}`;
  const query = `?cwd=${encodeURIComponent(f.cwd)}`;
  assert.equal((await (await fetch(`${base}/skills/learning-policy${query}`)).json()).policy.mode, "off");
  const policyResponse = await fetch(`${base}/skills/learning-policy${query}`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "off", expectedRevision: 0, limits: { perRequestOutputTokens: 1024 } }) });
  assert.equal(policyResponse.status, 200);
  const response = await fetch(`${base}/skills/learning-reviews${query}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: f.run.id, providerPresetId: provider.id, correction: "Also verify the ledger sum." }) });
  assert.equal(response.status, 202, await response.clone().text());
  const queued = (await response.json()).job;
  let job;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = (await (await fetch(`${base}/skills/learning-reviews/${queued.id}${query}`)).json()).job;
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "succeeded", JSON.stringify(job)); assert.equal(requests, 1);
  const candidate = f.store.getSkillCandidate(job.candidateIds[0]);
  assert.equal(candidate.status, "pending");
  const repeat = await fetch(`${base}/skills/learning-reviews${query}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: f.run.id, providerPresetId: provider.id, correction: "Also verify the ledger sum." }) });
  assert.equal((await repeat.json()).job.id, queued.id);
  assert.equal(requests, 1);
  const post = async (path, body) => fetch(`${base}${path}${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const revisionRequest = { expectedUpdatedAt: original.updatedAt, sourceCandidateId: candidate.id, definition: candidate.definition.skillDefinition };
  assert.equal((await post(`/skills/${original.id}/revisions`, revisionRequest)).status, 409, "pending is not approval");
  assert.equal((await post(`/skill-candidates/${candidate.id}/review`, { action: "approve_for_draft", reason: "Reviewed the source evidence" })).status, 200);
  assert.equal((await post(`/skill-candidates/${candidate.id}/draft`, {})).status, 409, "a correction cannot create an unrelated imported skill");
  f.database.exec("CREATE TRIGGER fail_candidate_publish BEFORE UPDATE ON skill_candidates WHEN new.status = 'published' BEGIN SELECT RAISE(ABORT, 'synthetic candidate publication failure'); END");
  assert.equal((await post(`/skills/${original.id}/revisions`, revisionRequest)).status, 400);
  assert.deepEqual(f.store.getSkillRegistryEntry(original.id).definition, original.definition);
  assert.equal(f.store.listSkillDefinitionRevisions(original.id).length, 1);
  assert.equal(f.store.getSkillCandidate(candidate.id).status, "approved_for_draft");
  f.database.exec("DROP TRIGGER fail_candidate_publish");
  const appliedResponse = await post(`/skills/${original.id}/revisions`, revisionRequest);
  assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
  const applied = await appliedResponse.json();
  assert.equal(applied.revision.sourceCandidateId, candidate.id); assert.equal(applied.revision.sourceJobId, queued.id);
  assert.equal(applied.revision.validationStatus, "schema_checked");
  assert.equal(f.store.getSkillCandidate(candidate.id).status, "published");
  for (const field of ["id", "source", "sourcePath", "packId", "visibility"]) assert.deepEqual(applied.skill[field], original[field]);
  assert.deepEqual(applied.skill.definition.requiredTools, original.definition.requiredTools);
  const history = await (await fetch(`${base}/skills/${original.id}/revisions${query}`)).json();
  assert.equal(history.revisions[0].id, applied.revision.id);
  const undoResponse = await post(`/skills/${original.id}/revision-undo`, { revisionId: applied.revision.id, expectedUpdatedAt: applied.skill.updatedAt });
  assert.equal(undoResponse.status, 200, await undoResponse.clone().text());
  const undo = await undoResponse.json(); assert.deepEqual(undo.skill.definition, original.definition);
  assert.equal(undo.revision.undoOfRevisionId, applied.revision.id);
  assert.equal((await post(`/skills/${original.id}/revisions`, revisionRequest)).status, 409, "a repeated apply cannot consume a published candidate twice");
  f.database.prepare("UPDATE run_sessions SET request_snapshot_json = '{}' WHERE id = ?").run(f.run.id);
  const unknownSource = await post("/skills/learning-reviews", { runId: f.run.id, providerPresetId: provider.id,
    correction: "A historical Run cannot prove which skill definition it used." });
  assert.equal(unknownSource.status, 400);
  assert.equal((await unknownSource.json()).error, "learning_skill_provenance_unavailable");
  assert.equal(requests, 1, "unknown historical provenance is rejected before another model request");
});

test("an intervening definition edit rejects a learned correction even with a fresh editor timestamp", async t => {
  const definition = { id: "amber", name: "Amber", summary: "Original", roleAffinity: ["engineer"], promptFragments: ["Read receipt."],
    requiredTools: ["read"], requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [] };
  const f = await learningFixture(t, { skillDefinition: definition });
  const { job, fence } = f.claim(f.enqueue("explicit", captureLearningEvidence(f.store, f.run.id, "Also verify the sum.")));
  const result = commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub });
  const candidate = f.store.applySkillCandidateReviewAction({ candidateId: result.candidateIds[0], actor: "user", action: "approve_for_draft" }, clock()).candidate;
  const before = f.store.getSkillRegistryEntry("amber");
  const manual = f.store.createSkillImportDraft({ source: "custom", name: "Amber", definitions: [{ definition: { ...definition, summary: "Later user edit" } }] }, clock());
  const current = f.store.publishSkillRevisionDraft({ draftId: manual.id, skillId: "amber", expectedUpdatedAt: before.updatedAt }, clock());
  const proposed = f.store.createSkillImportDraft({ source: "custom", name: "Amber", definitions: [{ definition: candidate.definition.skillDefinition }] }, clock());
  assert.throws(() => f.store.publishSkillRevisionDraft({ draftId: proposed.id, skillId: "amber", expectedUpdatedAt: current.updatedAt,
    sourceCandidateId: candidate.id, reviewedCandidateId: candidate.id }, clock()), error => error.code === "skill_revision_conflict");
  assert.equal(f.store.getSkillRegistryEntry("amber").definition.summary, "Later user edit");
  assert.equal(f.store.getSkillCandidate(candidate.id).status, "approved_for_draft");
});
