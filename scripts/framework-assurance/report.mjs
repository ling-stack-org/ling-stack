import { exactObject, requireCondition } from "./manifest.mjs";
import { parseObservation, compareObservations } from "./evidence.mjs";
import { isDeepStrictEqual } from "node:util";

const taskKey = item => [item.taskIdentity.suiteId, item.taskIdentity.suiteVersion, item.taskIdentity.taskId, item.taskIdentity.taskVersion];

export function parseObservationBundle(value) {
  exactObject(value, ["schemaVersion", "kind", "requestedCount", "observations"], "observation bundle");
  requireCondition(value.schemaVersion === 1 && value.kind === "offline_observations"
    && Number.isSafeInteger(value.requestedCount) && value.requestedCount >= 0 && value.requestedCount <= 10000
    && Array.isArray(value.observations) && value.observations.length <= 10000, "invalid_manifest", "Invalid observation bundle.");
  value.observations.forEach(parseObservation);
  return value;
}

export function observationBundle(calibration) {
  requireCondition(calibration.schemaVersion === 1 && calibration.kind === "offline_calibration", "invalid_manifest", "Expected offline calibration output.");
  return parseObservationBundle({ schemaVersion: 1, kind: "offline_observations", requestedCount: calibration.requestedCount,
    observations: structuredClone(calibration.observations) });
}

export function buildReport(bundle) {
  parseObservationBundle(bundle);
  const unique = new Map(); const observationIds = new Map();
  for (const observation of bundle.observations) {
    const key = JSON.stringify([observation.invocationId, ...taskKey(observation), observation.caseId]);
    const prior = unique.get(key);
    requireCondition(!prior || isDeepStrictEqual(prior, observation), "conflicting_observation", "The same invocation has conflicting observations.");
    requireCondition(!observationIds.has(observation.observationId) || observationIds.get(observation.observationId) === key,
      "conflicting_observation", "Observation identity is reused for a different invocation.");
    unique.set(key, observation); observationIds.set(observation.observationId, key);
  }
  const observations = [...unique.values()];
  requireCondition(bundle.requestedCount >= observations.length, "invalid_manifest", "Requested count cannot omit observed invocations.");
  const assessed = observations.filter(item => ["pass", "fail"].includes(item.assessment));
  const passed = assessed.filter(item => item.assessment === "pass").length;
  const countBy = field => Object.fromEntries([...new Set(observations.map(item => item[field]))].sort()
    .map(key => [key, observations.filter(item => item[field] === key).length]));
  const usageByRequest = new Map();
  for (const observation of observations) for (const entry of observation.usage) {
    const key = `${observation.invocationId}:${entry.requestId}`;
    const prior = usageByRequest.get(key);
    requireCondition(!prior || isDeepStrictEqual(prior, entry), "conflicting_observation", "Usage identity has conflicting settlements.");
    usageByRequest.set(key, entry);
  }
  const costs = { task: { knownSubtotals: {}, unknownCount: 0 }, grader: { knownSubtotals: {}, unknownCount: 0 } };
  for (const entry of usageByRequest.values()) {
    const bucket = costs[entry.scope];
    if (entry.status === "unknown") bucket.unknownCount += 1;
    else {
      bucket.knownSubtotals[entry.currency] = (bucket.knownSubtotals[entry.currency] ?? 0) + entry.amount;
      requireCondition(Number.isFinite(bucket.knownSubtotals[entry.currency]), "invalid_manifest", "Known usage subtotal overflowed.");
    }
  }
  const timings = {};
  for (const key of ["queueMs", "executionMs", "validationMs", "gradingMs"]) {
    const samples = observations.flatMap(item => item.timings[key] === null ? [] : [item.timings[key]]).sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const median = samples.length === 0 ? null : samples.length % 2 ? samples[middle] : samples[middle - 1] / 2 + samples[middle] / 2;
    timings[key] = { sampleCount: samples.length, medianMs: median,
      p95Ms: samples.length >= 20 ? samples[Math.ceil(samples.length * 0.95) - 1] : null };
  }
  return { schemaVersion: 1, kind: "offline_assurance_report", evidenceKinds: countBy("evidenceKind"),
    requested: bundle.requestedCount, observed: observations.length, duplicateExportsIgnored: bundle.observations.length - observations.length,
    unobserved: bundle.requestedCount - observations.length, assessed: assessed.length, passed,
    assessedPassRate: assessed.length ? passed / assessed.length : null,
    endToEndSuccessRate: bundle.requestedCount ? passed / bundle.requestedCount : null,
    assessments: countBy("assessment"), executionStates: countBy("executionStatus"), stopReasons: countBy("stopReason"), costs, timings,
    liveTaskRequested: 0, liveTaskPassed: 0,
    observations: observations.map(item => ({ observationId: item.observationId, invocationId: item.invocationId, caseId: item.caseId,
      taskIdentity: item.taskIdentity, sourceCommit: item.sourceCommit, inputDigests: item.inputDigests, comparison: item.comparison,
      evidenceKind: item.evidenceKind, executionStatus: item.executionStatus, assessment: item.assessment, stopReason: item.stopReason,
      effectStatus: item.effectStatus, artifacts: item.artifacts, limitations: item.limitations })),
    limitations: ["Offline controls or declared fixture replay only; no live task acceptance.",
      "Control pass rates are not task success rates or a framework performance claim.",
      "Known cost subtotals exclude unknown usage; currencies are never combined.",
      "Timing p95 requires at least 20 samples; this tool makes no statistical significance claim."] };
}

export function compareBundles(leftBundle, rightBundle, variable = null) {
  requireCondition([null, "model", "executionStrategy"].includes(variable), "invalid_manifest", "Only one supported comparison variable may be declared.");
  const left = buildReport(leftBundle); const right = buildReport(rightBundle);
  const key = item => JSON.stringify([...taskKey(item), item.caseId]);
  const group = bundle => {
    const groups = new Map();
    const unique = new Map(bundle.observations.map(item => [item.observationId, item]));
    for (const item of unique.values()) {
      const items = groups.get(key(item)) ?? [];
      items.push(item); groups.set(key(item), items);
    }
    return groups;
  };
  const leftGroups = group(leftBundle), rightGroups = group(rightBundle);
  const pairs = [...leftGroups].map(([identity, items]) => {
    const matches = rightGroups.get(identity) ?? [];
    const reasons = [];
    if (items.length !== matches.length) reasons.push("invocation_counts_differ");
    if (!matches.length) reasons.push("missing_comparison_case");
    else {
      // Compare homogeneous cohorts in linear time, not every pair of exports.
      reasons.push(...compareObservations(items[0], matches[0], variable).reasons);
      for (const cohort of [items, matches]) for (const item of cohort.slice(1)) {
        reasons.push(...compareObservations(cohort[0], item).reasons);
      }
    }
    return { taskIdentity: items[0].taskIdentity, caseId: items[0].caseId, leftCount: items.length, rightCount: matches.length,
      comparable: reasons.length === 0, reasons: [...new Set(reasons)] };
  });
  const unmatchedRight = [...rightGroups.keys()].filter(item => !leftGroups.has(item)).length;
  return { schemaVersion: 1, kind: "offline_assurance_comparison", variable,
    comparable: pairs.length > 0 && unmatchedRight === 0 && left.requested === right.requested
      && left.unobserved === 0 && right.unobserved === 0 && pairs.every(item => item.comparable),
    unmatchedRight, requestedCountsMatch: left.requested === right.requested,
    unobservedInvocations: { left: left.unobserved, right: right.unobserved }, pairs, left, right,
    limitations: ["No speedup or quality delta is asserted; only matched frozen inputs can be compared."] };
}

const cell = value => String(value).replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
export function renderReportMarkdown(report) {
  requireCondition(report.kind === "offline_assurance_report", "invalid_manifest", "Expected an offline report.");
  const ratio = value => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = ["# Ling Offline Assurance Report", "", "Evidence: offline controls / fixture replay. Live tasks executed: 0.", "",
    `Requested controls/fixtures: ${report.requested}; observed: ${report.observed}; assessed: ${report.assessed}.`,
    `Control/fixture pass rate: ${ratio(report.assessedPassRate)}; requested denominator: ${ratio(report.endToEndSuccessRate)}.`, "",
    "| Task | Control | Evidence | Assessment | Stop Reason |", "| --- | --- | --- | --- | --- |"];
  for (const item of report.observations) lines.push(`| ${cell(item.taskIdentity.taskId)} | ${cell(item.caseId)} | ${cell(item.evidenceKind)} | ${cell(item.assessment)} | ${cell(item.stopReason)} |`);
  lines.push("", "## Usage", "");
  for (const [scope, cost] of Object.entries(report.costs)) lines.push(`${scope}: known subtotals ${JSON.stringify(cost.knownSubtotals)}; unknown requests ${cost.unknownCount}.`);
  lines.push("", "## Limits", "", ...report.limitations.map(item => `- ${item}`), "");
  return lines.join("\n");
}
