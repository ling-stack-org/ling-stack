import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { CodeAssessmentComment, CodeAssessmentDetail } from "@ling-stack/contracts";
import type { CodeAssessmentCommentsStore } from "@ling-stack/core";
import { handleCodeAssessmentCommentRequest } from "../dist/features/code-assessments/comments.js";
import { HttpError } from "../dist/errors.js";
import { writeJson } from "../dist/shared/response.js";

test("comment handler lists and creates notes, rejecting mismatched snapshots and unknown findings", async t => {
  const now = "2026-11-17T00:00:00Z";
  const snapshot = { id: "snapshot", digest: "a".repeat(64), capturedAt: now, target: { type: "working_tree" as const },
    files: [], totalFileCount: 0, coverage: "complete" as const, exclusions: [] };
  const detail: CodeAssessmentDetail = { snapshot, assessment: { id: "assessment", kind: "review", status: "completed", providerPresetId: "provider",
    snapshotId: snapshot.id, snapshotDigest: snapshot.digest, target: snapshot.target, findingCount: 1, createdAt: now, updatedAt: now,
    phase: "completed", phaseHistory: [{ phase: "completed", enteredAt: now }], metrics: {}, validation: { state: "inconclusive", reason: "Tool-free assessment." } },
    findings: [{ id: "finding", assessmentId: "assessment", snapshotDigest: snapshot.digest, fingerprint: "b".repeat(64), title: "Bug", body: "Specific failure",
      severity: "high", confidence: "high", path: "a.ts", side: "old", startLine: 1, endLine: 1, evidence: "old", validation: "unverified", disposition: "open" }] };
  const comments: CodeAssessmentComment[] = [];
  const store: CodeAssessmentCommentsStore = {
    createCodeAssessmentComment(assessmentId, findingId, { now: createdAt, ...input }) {
      const comment = { ...input, assessmentId, findingId, createdAt }; comments.push(comment); return comment;
    },
    listCodeAssessmentComments() { return comments; },
  };
  const server = createServer((request, response) => {
    void handleCodeAssessmentCommentRequest(request, response, store, detail, request.url === "/missing" ? "missing" : "finding")
      .catch((error: unknown) => writeJson(response, error instanceof HttpError ? error.statusCode : 400,
        { error: error instanceof HttpError ? error.code : "assessment_failed" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.close(); await once(server, "close"); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const input = { snapshotDigest: snapshot.digest, path: "a.ts", side: "old", startLine: 1, endLine: 1, body: "Investigate the caller." };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const createdResponse = await post("/comments", input); assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as CodeAssessmentComment;
  assert.match(created.id, /^comment_/u); assert.equal(created.assessmentId, "assessment"); assert.equal(created.findingId, "finding");
  assert.deepEqual(await (await fetch(`${base}/comments`)).json(), { comments: [created] });
  const mismatch = await post("/comments", { ...input, snapshotDigest: "c".repeat(64) });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json() as { error: string }).error, "snapshot_changed");
  assert.equal((await post("/missing", input)).status, 404);
  assert.equal((await post("/comments", { ...input, tools: ["exec"] })).status, 400);
  assert.equal((await fetch(`${base}/comments`, { method: "DELETE" })).status, 405);
  assert.equal(comments.length, 1);
});
