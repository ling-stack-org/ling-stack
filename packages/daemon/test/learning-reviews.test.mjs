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
  const f = await learningFixture(t, { correction: "Compare the ledger sum as well as the receipt total.", selectedSkillId: "amber" });
  const definition = { id: "amber", name: "Amber", summary: "Reconcile receipts", roleAffinity: ["engineer"],
    promptFragments: ["Read receipt total."], requiredTools: ["read"], requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "strict", risk: "high" }, stateEffects: [] };
  const imported = f.store.createSkillImportDraft({ source: "custom", name: "Amber", definitions: [{ definition }] }, clock());
  f.store.publishSkillImportDraft(imported.id, clock());
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

test("daemon HTTP save runs the bounded model request and retains a reviewable candidate across API reads", async t => {
  const { createSqliteRunStore } = await import("@ling-stack/core");
  const { createDaemonServer } = await import("../dist/index.js");
  const f = await learningFixture(t); let requests = 0;
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
    body: JSON.stringify({ runId: f.run.id, providerPresetId: provider.id }) });
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
    body: JSON.stringify({ runId: f.run.id, providerPresetId: provider.id }) });
  assert.equal((await repeat.json()).job.id, queued.id);
  assert.equal(requests, 1);
});
