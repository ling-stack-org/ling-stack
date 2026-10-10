import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createHumanEvaluationDaemonClient } from "../dist/main/human-evaluation/daemon-client.js";
import { parseHumanEvaluationListResponse, parseHumanEvaluationReportResponse } from "../dist/main/human-evaluation/read-response.js";

const now = "2026-10-10T10:00:00.000Z", digest = "a".repeat(64);
const ref = { taskId: "task-qa", eventId: "event-qa", revision: 1 };
const pin = { artifactId: "artifact", contentSha256: digest };
const canonical = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : Array.isArray(value) ? value.map(canonical) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function fixture() {
  const report = { schemaVersion: 1, authority: "report-only", ref, event: { schemaVersion: 1, id: ref.eventId, taskId: ref.taskId,
    enrollmentId: "enrollment", evaluationId: "evaluation", intentId: "intent", revision: 1,
    submission: { kind: "adjudicate", decision: { verdict: "pass", rationale: "Reviewed synthetic evidence." } }, payloadDigest: digest,
    confirmation: { kind: "macos_device_owner_authentication", requestId: "request", payloadDigest: digest, confirmedAt: now }, auditSeq: 1, createdAt: now },
    intent: { id: "intent", payloadDigest: digest }, lineage: { enrollmentId: "enrollment", batchId: "batch", evaluationId: "evaluation", evaluationKey: "key",
      artifactPins: { suite: pin, case: pin, baseline: pin, candidate: pin, frozen: pin }, configArtifact: pin,
      configDigest: digest, frozenGraderDigest: digest, rubric: { id: "rubric", version: "1", instructions: "Compare QA-only evidence." }, rubricDigest: digest },
    audit: { seq: 1, action: "human_evaluation_adjudicated", createdAt: now } };
  report.reportDigest = hash(report);
  return structuredClone({ accepted: true, canonicalWorkspaceCwd: "/qa", report, head: { eventId: ref.eventId, revision: 1, state: "active" }, currentness: "current" });
}
const row = () => ({ enrollmentId: "enrollment", taskId: ref.taskId, evaluationId: "evaluation", createdAt: now,
  taskState: "queued", suiteId: "suite", suiteVersion: "1", caseId: "case", caseVersion: "1" });

test("read DTOs expose bounded enrollment metadata and immutable report-only lineage", () => {
  const list = parseHumanEvaluationListResponse({ accepted: true, canonicalWorkspaceCwd: "/qa", items: [row()], nextAfterEnrollmentId: "enrollment" }, 1);
  assert.equal(list.items[0].taskState, "queued");
  const body = fixture(), parsed = parseHumanEvaluationReportResponse(body, ref);
  assert.equal(parsed.report.authority, "report-only"); assert.equal(parsed.report.reportDigest, body.report.reportDigest);
  body.head = { eventId: "event-later", revision: 2, state: "active" }; body.currentness = "stale";
  assert.equal(parseHumanEvaluationReportResponse(body, ref).report.reportDigest, parsed.report.reportDigest);
});

for (const corrupt of ["unknownTop", "identity", "ref", "intent", "audit", "digest", "currentness", "pins", "rationale", "rubric"]) {
  test(`report DTO rejects ${corrupt} corruption before Renderer`, () => {
    const body = fixture();
    if (corrupt === "unknownTop") body.confirmationKey = "must-not-leak";
    if (corrupt === "identity") body.report.event.binding = { osUserId: "must-not-leak" };
    if (corrupt === "ref") body.report.ref.taskId = "other";
    if (corrupt === "intent") body.report.intent.id = "other";
    if (corrupt === "audit") body.report.audit.seq = 2;
    if (corrupt === "digest") body.report.reportDigest = "0".repeat(64);
    if (corrupt === "currentness") body.currentness = "stale";
    if (corrupt === "pins") body.report.lineage.artifactPins.suite.contentSha256 = "invalid";
    if (corrupt === "rationale") body.report.event.submission.decision.rationale = "x".repeat(4097);
    if (corrupt === "rubric") body.report.lineage.rubric.instructions = "x".repeat(4097);
    assert.throws(() => parseHumanEvaluationReportResponse(body, ref), /human_daemon_response_invalid/);
  });
}
test("list rejects mismatched cursor, duplicate IDs, unknown task state, private fields and oversized pages", () => {
  for (const body of [
    { accepted: true, canonicalWorkspaceCwd: "/qa", items: [row()], nextAfterEnrollmentId: "other" },
    { accepted: true, canonicalWorkspaceCwd: "/qa", items: [row(), row()] },
    { accepted: true, canonicalWorkspaceCwd: "/qa", items: [{ ...row(), taskState: "success" }] },
    { accepted: true, canonicalWorkspaceCwd: "/qa", items: [{ ...row(), prompt: "private" }] },
    { accepted: true, canonicalWorkspaceCwd: "/qa", items: Array.from({ length: 26 }, (_, n) => ({ ...row(), enrollmentId: `e${n}` })) },
  ]) assert.throws(() => parseHumanEvaluationListResponse(body), /human_daemon_response_invalid/);
});

test("Main report/list transport enforce separate UTF8 wire caps and reject malformed UTF8", async () => {
  const signal = new AbortController().signal, authority = {};
  for (const [action, cap] of [["list", 2_097_152], ["report", 262_144]]) {
    let dispatches = 0;
    const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "owned",
      fetch: async () => { dispatches++; return new Response(" ".repeat(cap + 1), { status: 200 }); } });
    await assert.rejects(action === "list" ? client.list({ authority }, signal) : client.report({ authority, ...ref }, signal), /human_daemon_response_invalid/);
    assert.equal(dispatches, 1);
  }
  const invalid = createHumanEvaluationDaemonClient({ daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "owned",
    fetch: async () => new Response(Uint8Array.of(0xc3, 0x28), { status: 200 }) });
  await assert.rejects(invalid.list({ authority }, signal));
});

test("Main list does not inherit mutation65KiB; full JSON-escaped metadata stays bounded", async () => {
  const items = Array.from({ length: 50 }, (_, n) => ({ ...row(), enrollmentId: `${"\ud800".repeat(497)}${String(n).padStart(3, "0")}`,
    taskId: "\ud800".repeat(500), evaluationId: "\ud800".repeat(500),
    suiteId: "\ud800".repeat(500), suiteVersion: "\ud800".repeat(500), caseId: "\ud800".repeat(500), caseVersion: "\ud800".repeat(500) }));
  const body = { accepted: true, canonicalWorkspaceCwd: "/qa", items, nextAfterEnrollmentId: items.at(-1).enrollmentId };
  assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") > 1_048_576);
  const client = createHumanEvaluationDaemonClient({ daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "owned",
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
  assert.equal((await client.list({ authority: {}, limit: 50 }, new AbortController().signal)).items.length, 50);
});

test("new read DTO source boundaries accept identity500/rationale4096 and reject one beyond", () => {
  for (const field of ["suiteId", "suiteVersion", "caseId", "caseVersion"]) {
    const body = { accepted: true, canonicalWorkspaceCwd: "/qa", items: [{ ...row(), [field]: "x".repeat(500) }] };
    assert.equal(parseHumanEvaluationListResponse(body).items[0][field].length, 500);
    body.items[0][field] += "x";
    assert.throws(() => parseHumanEvaluationListResponse(body), /human_daemon_response_invalid/);
  }
  const body = fixture();
  body.report.event.submission.decision.rationale = "x".repeat(4096);
  body.report.lineage.rubric.id = "x".repeat(500);
  body.report.lineage.configArtifact.artifactId = "x".repeat(500);
  body.report.lineage.artifactPins.suite.artifactId = "x".repeat(500);
  const { reportDigest, ...content } = body.report; body.report.reportDigest = hash(content);
  assert.equal(parseHumanEvaluationReportResponse(body, ref).report.event.submission.decision.rationale.length, 4096);
  body.report.lineage.configArtifact.artifactId += "x";
  assert.throws(() => parseHumanEvaluationReportResponse(body, ref), /human_daemon_response_invalid/);
});
