import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { exactObject, identifier, digest, requireCondition, sha256 } from "./manifest.mjs";
import { loadCoreGrader } from "./grader.mjs";
import { assessControl, preflight } from "./preflight.mjs";

const DIGEST_KEYS = ["suiteBytes", "taskBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes"];
const COMPARISON_KEYS = ["model", "reasoning", "executionStrategy", "node", "platform", "arch"];
const TIMING_KEYS = ["queueMs", "executionMs", "validationMs", "gradingMs"];

export function parseObservation(value) {
  exactObject(value, ["schemaVersion", "observationId", "invocationId", "caseId", "taskIdentity", "sourceCommit", "inputDigests", "comparison",
    "evidenceKind", "executionStatus", "assessment", "stopReason", "effectStatus", "timings", "usage", "artifacts", "limitations"], "observation");
  requireCondition(value.schemaVersion === 1, "invalid_manifest", "Unsupported observation schema.");
  for (const key of ["observationId", "invocationId", "caseId", "stopReason"]) identifier(value[key], key);
  exactObject(value.taskIdentity, ["suiteId", "suiteVersion", "taskId", "taskVersion"], "task identity");
  Object.values(value.taskIdentity).forEach(item => identifier(item, "task identity"));
  requireCondition(typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(value.sourceCommit),
    "invalid_manifest", "Observation source commit must be frozen.");
  exactObject(value.inputDigests, DIGEST_KEYS, "input digests");
  Object.values(value.inputDigests).forEach(item => digest(item, "input digest"));
  exactObject(value.comparison, COMPARISON_KEYS, "comparison environment");
  Object.values(value.comparison).forEach(item => identifier(item, "comparison value"));
  requireCondition(["synthetic_control", "fixture_replay"].includes(value.evidenceKind), "unsupported_evidence_kind",
    "This offline tool does not accept live execution evidence; F3 authority integration is not implemented.");
  requireCondition(["not_started", "running", "completed", "failed", "cancelled", "timed_out", "unknown"].includes(value.executionStatus)
    && ["pass", "fail", "not_assessed", "invalid_evidence"].includes(value.assessment)
    && ["none", "confirmed", "unknown"].includes(value.effectStatus), "invalid_manifest", "Invalid observation state.");
  requireCondition(!["pass", "fail"].includes(value.assessment) || value.executionStatus === "completed",
    "invalid_manifest", "An assessed result requires completed verification.");
  requireCondition(value.assessment !== "pass" || value.effectStatus !== "unknown", "invalid_manifest", "Unknown effects cannot be reported as passing.");
  exactObject(value.timings, TIMING_KEYS, "timings");
  Object.values(value.timings).forEach(item => requireCondition(item === null || (Number.isFinite(item) && item >= 0), "invalid_manifest", "Invalid timing value."));
  requireCondition(Array.isArray(value.usage) && value.usage.length <= 1000, "invalid_manifest", "Usage must be bounded.");
  const requestIds = new Set();
  for (const item of value.usage) {
    exactObject(item, ["requestId", "scope", "status", "amount", "currency", "source"], "usage entry");
    identifier(item.requestId, "request id"); identifier(item.source, "usage source");
    requireCondition(!requestIds.has(item.requestId), "invalid_manifest", "Usage request identities must be unique.");
    requestIds.add(item.requestId);
    requireCondition(["task", "grader"].includes(item.scope) && ["known", "unknown"].includes(item.status), "invalid_manifest", "Invalid usage state.");
    requireCondition(item.currency === null || (typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency)), "invalid_manifest", "Invalid currency.");
    requireCondition(item.status === "unknown" ? item.amount === null
      : Number.isFinite(item.amount) && item.amount >= 0 && item.currency !== null, "invalid_manifest", "Known and unknown amounts must remain distinct.");
  }
  requireCondition(Array.isArray(value.artifacts) && value.artifacts.length >= 1 && value.artifacts.length <= 100,
    "invalid_manifest", "Observation artifact evidence is required.");
  for (const item of value.artifacts) {
    exactObject(item, ["role", "sha256"], "observation artifact"); identifier(item.role, "artifact role"); digest(item.sha256, "artifact digest");
  }
  requireCondition(Array.isArray(value.limitations) && value.limitations.length >= 1 && value.limitations.length <= 100,
    "invalid_manifest", "Evidence limitations must be explicit.");
  value.limitations.forEach(item => identifier(item, "limitation code"));
  return value;
}

export async function calibrate(options) {
  const checked = await preflight(options);
  const core = await loadCoreGrader(options.repoRoot);
  const invocationId = options.invocationId ?? randomUUID();
  identifier(invocationId, "invocation id");
  const observations = []; const controls = [];
  for (const { task, taskByteDigest, rule, expected, controls: candidates } of checked.tasks) {
    for (const [caseId, candidate] of Object.entries(candidates)) {
      const start = performance.now();
      const result = assessControl({ core, task, rule, expected, candidate });
      const gradingMs = performance.now() - start;
      const observation = parseObservation({
        schemaVersion: 1, observationId: sha256(`${invocationId}:${task.taskId}:${caseId}`), invocationId, caseId,
        taskIdentity: { suiteId: checked.suite.suiteId, suiteVersion: checked.suite.suiteVersion, taskId: task.taskId, taskVersion: task.taskVersion },
        sourceCommit: task.source.commit,
        inputDigests: { suiteBytes: checked.suiteByteDigest, taskBytes: taskByteDigest, ruleBytes: task.ruleCase.sha256,
          expectedBytes: task.expected.sha256, profileBytes: task.validationProfile.artifact.sha256, lockBytes: task.source.lockSha256 },
        comparison: { model: "none", reasoning: "none", executionStrategy: "offline_control_only", node: process.versions.node,
          platform: process.platform, arch: process.arch },
        evidenceKind: "synthetic_control", executionStatus: "completed", assessment: result.assessment,
        stopReason: result.assessment === "invalid_evidence" ? "required_evidence_missing" : "rule_evaluated",
        effectStatus: "none", timings: { queueMs: null, executionMs: null, validationMs: null, gradingMs }, usage: [],
        artifacts: [{ role: "candidate", sha256: task.controls[caseId].candidate.sha256 }, { role: "rule", sha256: task.ruleCase.sha256 },
          { role: "baseline", sha256: task.expected.sha256 }],
        limitations: ["synthetic_control_only", "no_task_code_executed", "no_live_run_acceptance"],
      });
      observations.push(observation);
      controls.push({ taskId: task.taskId, caseId, expectedAssessment: task.controls[caseId].expectedAssessment,
        observedAssessment: result.assessment, matched: result.assessment === task.controls[caseId].expectedAssessment,
        score: result.score, rationale: result.rationale });
    }
  }
  return { schemaVersion: 1, kind: "offline_calibration", suiteId: checked.suite.suiteId, suiteVersion: checked.suite.suiteVersion,
    invocationId, suiteByteDigest: checked.suiteByteDigest, passed: controls.every(item => item.matched),
    requestedCount: controls.length, controls, observations, graderSourceDigests: core.sourceDigests,
    externalProviderCalls: 0, ordinaryRunsDispatched: 0, userStoresInitialized: 0, taskCodeExecuted: false };
}

export function compareObservations(left, right, variable = null) {
  parseObservation(left); parseObservation(right);
  requireCondition([null, "model", "executionStrategy"].includes(variable), "invalid_manifest", "Only one supported comparison variable may be declared.");
  const reasons = [];
  for (const key of Object.keys(left.taskIdentity)) if (left.taskIdentity[key] !== right.taskIdentity[key]) reasons.push(`taskIdentity.${key}`);
  for (const key of DIGEST_KEYS) if (left.inputDigests[key] !== right.inputDigests[key]) reasons.push(`inputDigests.${key}`);
  for (const key of COMPARISON_KEYS) if (key !== variable && left.comparison[key] !== right.comparison[key]) reasons.push(`comparison.${key}`);
  for (const key of ["sourceCommit", "evidenceKind", "caseId"]) if (left[key] !== right[key]) reasons.push(key);
  return { comparable: reasons.length === 0, variable, reasons };
}
