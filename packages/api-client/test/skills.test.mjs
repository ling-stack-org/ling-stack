import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError } from "../dist/index.js";

function fixture() {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return Response.json({ jobs: [], revisions: [] });
  } });
  return { client, calls };
}

// Value: protects=learning policy, selected evidence, optional filters and cancellation use the public wire contract;
// fails_when=source/correction/provider/revision is omitted or job identity is interpolated without encoding;
// why_new=daemon coordinator tests do not invoke the client transport; seam=none;
// no_claim=learning model quality, durable idempotency or UI state (fetch mocked).
test("learning client retains selected source, provider, correction, policy revision and optional filters", async () => {
  const { client, calls } = fixture();
  const cwd = "/repo 中文", jobId = "learning / job?&";
  const policy = { mode: "propose", providerPresetId: "local", expectedRevision: 2, limits: { maxRequests: 1 } };
  const run = { runId: "run / 一", providerPresetId: "local", correction: "Read the signed receipt first." };
  const decision = { decisionId: "decision / 二", providerPresetId: "local" };
  await client.getLearningReviewPolicy(cwd);
  await client.updateLearningReviewPolicy(cwd, policy);
  await client.createLearningReview(cwd, run);
  await client.createLearningReview(cwd, decision);
  await client.listLearningReviews(cwd);
  await client.listLearningReviews(cwd, run.runId);
  await client.listLearningReviews(cwd, undefined, decision.decisionId);
  await client.getLearningReview(cwd, jobId);
  await client.cancelLearningReview(cwd, jobId);
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ["GET", "/skills/learning-policy"], ["PUT", "/skills/learning-policy"],
    ["POST", "/skills/learning-reviews"], ["POST", "/skills/learning-reviews"],
    ["GET", "/skills/learning-reviews"], ["GET", "/skills/learning-reviews"], ["GET", "/skills/learning-reviews"],
    ["GET", `/skills/learning-reviews/${encodeURIComponent(jobId)}`],
    ["POST", `/skills/learning-reviews/${encodeURIComponent(jobId)}/cancel`],
  ]);
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === cwd));
  assert.deepEqual(calls.slice(0, 4).map(call => call.body), [undefined, policy, run, decision]);
  assert.deepEqual(Object.fromEntries(calls[4].url.searchParams), { cwd });
  assert.deepEqual(Object.fromEntries(calls[5].url.searchParams), { cwd, runId: run.runId });
  assert.deepEqual(Object.fromEntries(calls[6].url.searchParams), { cwd, decisionId: decision.decisionId });
  assert.deepEqual(calls[8].body, {});
});

// Value: protects=definition history/undo preserve skill identity and caller-supplied conflict/authority fields;
// fails_when=the client alters expected revision/time or silently confirms authority changes;
// why_new=server history tests bypass client serialization and client transport lacks these methods; seam=none;
// no_claim=SQLite CAS, undo idempotency or browser confirmation (fetch mocked).
test("definition history and undo client requests keep CAS and authority confirmation explicit", async () => {
  const { client, calls } = fixture();
  const cwd = "/repo", skillId = "skill / 中文";
  const request = { revisionId: "revision / original", expectedUpdatedAt: "2026-10-01T00:00:00.001Z", reason: "Restore reviewed method" };
  await client.getSkillDefinitionHistory(cwd, skillId);
  await client.undoSkillDefinitionRevision(cwd, skillId, request);
  await client.undoSkillDefinitionRevision(cwd, skillId, { ...request, confirmAuthorityChanges: true });
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ["GET", `/skills/${encodeURIComponent(skillId)}/revisions`],
    ["POST", `/skills/${encodeURIComponent(skillId)}/revision-undo`],
    ["POST", `/skills/${encodeURIComponent(skillId)}/revision-undo`],
  ]);
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === cwd));
  assert.deepEqual(calls[1].body, request);
  assert.equal(Object.hasOwn(calls[1].body, "confirmAuthorityChanges"), false);
  assert.deepEqual(calls[2].body, { ...request, confirmAuthorityChanges: true });
  const conflict = new LingDaemonClient({ fetch: async () => Response.json({ error: "skill_revision_conflict" }, { status: 409 }) });
  await assert.rejects(conflict.undoSkillDefinitionRevision(cwd, skillId, request),
    error => error instanceof LingDaemonError && error.status === 409 && error.code === "skill_revision_conflict");
});
