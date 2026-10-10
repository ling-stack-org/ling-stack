export const qaCwd = "/qa-only";
export const qaTime = "2026-10-10T00:00:00.000Z";
export function qaRow(taskId = "task") {
  return { taskId, enrollmentId: `enrolled:${taskId}`, evaluationId: `evaluation:${taskId}`, createdAt: qaTime,
    taskState: "completed", suiteId: "review-suite", suiteVersion: "1", caseId: "redacted-case", caseVersion: "1" };
}
export function qaEvent(revision = 1, kind = "adjudicate", taskId = "task", requestId = "request:one") {
  return { schemaVersion: 1, id: `event:${taskId}:${revision}`, taskId, enrollmentId: `enrolled:${taskId}`,
    evaluationId: `evaluation:${taskId}`, intentId: `intent:${revision}`, revision,
    submission: kind === "revoke" ? { kind, revokesEventId: `event:${taskId}:${revision - 1}`, rationale: "withdrawn" }
      : { kind, ...(kind === "correct" ? { supersedesEventId: `event:${taskId}:${revision - 1}` } : {}),
        decision: { verdict: "pass", rationale: `reviewed:${revision}` } },
    payloadDigest: "a".repeat(64), confirmation: { kind: "macos_device_owner_authentication", requestId,
      payloadDigest: "a".repeat(64), confirmedAt: qaTime }, auditSeq: revision, createdAt: qaTime };
}
export function qaSnapshot(events = [], overrides = {}) {
  const headEvent = events.at(-1);
  return { accepted: true, taskId: "task", events, lastSubmission: "none", ...(headEvent ? { headEvent,
    head: { schemaVersion: 1, taskId: "task", enrollmentId: "enrolled:task", evaluationId: "evaluation:task",
      revision: headEvent.revision, eventId: headEvent.id, state: headEvent.submission.kind === "revoke" ? "revoked" : "active", updatedAt: qaTime } } : {}), ...overrides };
}
export function qaReport(event = qaEvent()) {
  return { accepted: true, workspaceCwd: qaCwd, canonicalWorkspaceCwd: qaCwd, currentness: "current",
    head: { eventId: event.id, revision: event.revision, state: "active" }, report: { schemaVersion: 1, authority: "report-only",
      ref: { taskId: event.taskId, eventId: event.id, revision: event.revision }, event,
      intent: { id: event.intentId, payloadDigest: event.payloadDigest }, lineage: {
        enrollmentId: event.enrollmentId, batchId: "batch", evaluationId: event.evaluationId, evaluationKey: "key",
        artifactPins: {}, configArtifact: { artifactId: "config", contentSha256: "b".repeat(64) },
        configDigest: "c".repeat(64), frozenGraderDigest: "d".repeat(64), rubricDigest: "e".repeat(64),
        rubric: { id: "rubric", version: "1", instructions: "redacted QA rubric" } },
      audit: { seq: event.auditSeq, action: `human_evaluation.${event.submission.kind}`, createdAt: qaTime }, reportDigest: "f".repeat(64) } };
}
export function qaCapability(overrides = {}) {
  return { list: async () => ({ accepted: true, workspaceCwd: qaCwd, canonicalWorkspaceCwd: qaCwd, items: [qaRow()] }),
    inspect: async () => qaSnapshot(), submit: async () => ({ accepted: false, reason: "cancelled" }),
    cancel: async () => ({ accepted: true }), generateReport: async () => qaReport(), ...overrides };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
