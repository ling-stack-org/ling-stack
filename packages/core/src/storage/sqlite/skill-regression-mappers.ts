import type { SQLOutputValue } from "node:sqlite";
import { skillRegressionGuardrails } from "../../skill-regression-policy.js";
import type {
  SkillRegressionCaseResult,
  SkillRegressionFixture,
  SkillRegressionLifecycleVerdict,
  SkillRegressionObservation,
  SkillRegressionRun,
  SkillRegressionSummary,
} from "../../skill-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  readBoolean,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapSkillRegressionRun(row: Record<string, SQLOutputValue>): SkillRegressionRun {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    skillId: readString(row, "skill_id"),
    sourceSnapshotId: readNullableString(row, "source_snapshot_id"),
    compiledViewId: readNullableString(row, "compiled_view_id"),
    suiteId: readNullableString(row, "suite_id"),
    guardrails: skillRegressionGuardrails,
    fixtures: parseJson(readString(row, "fixtures_json")) as readonly SkillRegressionFixture[],
    observations: parseJson(readString(row, "observations_json")) as readonly SkillRegressionObservation[],
    results: parseJson(readString(row, "results_json")) as readonly SkillRegressionCaseResult[],
    summary: parseJsonObject(readString(row, "summary_json")) as unknown as SkillRegressionSummary,
    lifecycleVerdict: readString(row, "lifecycle_verdict") as SkillRegressionLifecycleVerdict,
    autoSafeEligible: readBoolean(row, "auto_safe_eligible"),
    createdAt: readString(row, "created_at"),
  });
}
