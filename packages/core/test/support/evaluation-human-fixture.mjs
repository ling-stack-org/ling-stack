import { digestRunEvaluationValue } from "../../dist/index.js";
import { qaFixture, value, now, later } from "./evaluation-qa-fixture.mjs";
export const humanExpires = "2026-10-10T00:03:00.000Z";
export const binding = { daemonEpoch: "daemon-1", desktopInstanceId: "desktop-instance-1", desktopEpoch: "desktop-1", connectionEpoch: "connection-1", osSessionId: "session-1", osUserId: "user-1", lockEpoch: "lock-1" };
export const adjudicate = { kind: "adjudicate", decision: { verdict: "pass", score: 0.8, severity: "info", rationale: "Explicit synthetic human review" } };
/** A new legal QA rubric/config/frozen tuple. Never changes the preexisting 159 fixture's semantics. */
export async function humanFixture(t) {
  const f = await qaFixture(t);
  const rubric = { id: "synthetic-rubric", version: "1", instructions: "Compare only synthetic sealed evidence." };
  const frozen = { ...f.frozen, rubricDigest: digestRunEvaluationValue(rubric) };
  const frozenPin = f.artifact("human-frozen", frozen);
  const config = { schemaVersion: 1, input: { rubric }, resultSchema: {}, sampling: "fixture" };
  const configPin = f.artifact("human-config", config);
  const batch = value(f.store.createRunEvaluationQaBatch({ configSnapshotRef: configPin.artifactId, configDigest: digestRunEvaluationValue(config), now }));
  const pins = { ...f.pins, frozen: frozenPin };
  const enrollment = value(f.store.enrollRunEvaluationQaTask({ ...f.enqueue, frozenGraderArtifact: frozenPin, frozenGraderDigest: digestRunEvaluationValue(frozen), artifactPins: pins, batchId: batch.id, reviewRef: "host-human-review:synthetic", now }));
  const createInput = (requestId = "human-request-1", submission = adjudicate, at = later) => ({ taskId: enrollment.taskId, requestId, submission, binding: { ...binding }, expiresAt: humanExpires, now: at });
  const create = (requestId, submission, chosen = f.store, at = later) => value(chosen.createRunEvaluationHumanIntent(createInput(requestId, submission, at)));
  const commitInput = (intent, at = later) => ({ intentId: intent.id, payloadDigest: intent.payloadDigest, binding: { ...intent.payload.binding }, confirmation: { kind: "macos_device_owner_authentication", requestId: intent.payload.requestId, payloadDigest: intent.payloadDigest, confirmedAt: at }, now: at, assertAuthorityCurrent: () => {} });
  const commit = (intent, chosen = f.store, at = later) => value(chosen.commitRunEvaluationHumanIntent(commitInput(intent, at)));
  return { ...f, humanRubric: rubric, humanFrozen: frozen, humanConfig: config, humanConfigPin: configPin, humanBatch: batch, humanPins: pins, humanEnrollment: enrollment, createInput, create, commitInput, commit };
}
