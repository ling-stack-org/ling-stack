import { digestRunEvaluationValue } from "@ling-stack/core";
import type { RunEvaluationHumanReportSourceV1, RunEvaluationHumanReportV1 } from "@ling-stack/contracts";
import { copyQaModelJson } from "./qa-model-json.js";

/** Derive an immutable report from Core's verified atomic read. Never writes grades, promotion or history. */
export function produceHumanEvaluationReport(source: RunEvaluationHumanReportSourceV1): RunEvaluationHumanReportV1 {
  const report = { schemaVersion: 1 as const, authority: "report-only" as const,
    ref: source.ref, event: source.event, intent: source.intent, lineage: source.lineage, audit: source.audit };
  // Current head/currentness are deliberately outside the immutable digest.
  return copyQaModelJson({ ...report, reportDigest: digestRunEvaluationValue(report) }, 262_144) as unknown as RunEvaluationHumanReportV1;
}
