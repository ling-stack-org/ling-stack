import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { createSkillRegressionRunId, type CreateSkillRegressionRunInput, type ListSkillRegressionRunsOptions, type SkillRegressionRun } from "../../skill-types.js";
import { skillRegressionGuardrails } from "../../skill-regression-policy.js";
import { stringifyJson } from "./helpers.js";
import { mapSkillRegressionRun } from "./skill-regression-mappers.js";
import { skillRegressionRunSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteSkillRegressionStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createSkillRegressionRun(input: CreateSkillRegressionRunInput, now: string): SkillRegressionRun {
    if (input.fixtures.length === 0) {
      throw new Error("skill regression run requires at least one fixture");
    }
    if (input.observations.length === 0) {
      throw new Error("skill regression run requires at least one observation");
    }
    const run: SkillRegressionRun = {
      id: input.id ?? createSkillRegressionRunId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      skillId: input.skillId,
      sourceSnapshotId: input.sourceSnapshotId,
      compiledViewId: input.compiledViewId,
      suiteId: input.suiteId,
      guardrails: skillRegressionGuardrails,
      fixtures: input.fixtures,
      observations: input.observations,
      results: input.results,
      summary: input.summary,
      lifecycleVerdict: input.lifecycleVerdict,
      autoSafeEligible: input.autoSafeEligible,
      createdAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO skill_regression_runs (
          id,
          workspace_id,
          skill_id,
          source_snapshot_id,
          compiled_view_id,
          suite_id,
          fixtures_json,
          observations_json,
          results_json,
          summary_json,
          lifecycle_verdict,
          auto_safe_eligible,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.workspaceId,
        run.skillId,
        run.sourceSnapshotId ?? null,
        run.compiledViewId ?? null,
        run.suiteId ?? null,
        stringifyJson(run.fixtures),
        stringifyJson(run.observations),
        stringifyJson(run.results),
        stringifyJson(run.summary),
        run.lifecycleVerdict,
        run.autoSafeEligible ? 1 : 0,
        run.createdAt,
      );
    const created = this.getSkillRegressionRun(run.id);
    if (!created) {
      throw new Error(`Failed to create skill regression run: ${run.id}`);
    }
    return created;
  }

  getSkillRegressionRun(id: string): SkillRegressionRun | undefined {
    const row = this.context.database.prepare(skillRegressionRunSelectSql("WHERE id = ?")).get(id);
    return row ? mapSkillRegressionRun(row as Record<string, SQLOutputValue>) : undefined;
  }

  listSkillRegressionRuns(options: ListSkillRegressionRunsOptions = {}): SkillRegressionRun[] {
    const clauses = ["workspace_id = ?"];
    const values: SQLInputValue[] = [DEFAULT_WORKSPACE_ID];
    if (options.skillId) {
      clauses.push("skill_id = ?");
      values.push(options.skillId);
    }
    if (options.sourceSnapshotId) {
      clauses.push("source_snapshot_id = ?");
      values.push(options.sourceSnapshotId);
    }
    if (options.compiledViewId) {
      clauses.push("compiled_view_id = ?");
      values.push(options.compiledViewId);
    }
    if (options.suiteId) {
      clauses.push("suite_id = ?");
      values.push(options.suiteId);
    }
    if (options.lifecycleVerdict) {
      clauses.push("lifecycle_verdict = ?");
      values.push(options.lifecycleVerdict);
    }
    if (options.autoSafeEligible !== undefined) {
      clauses.push("auto_safe_eligible = ?");
      values.push(options.autoSafeEligible ? 1 : 0);
    }
    values.push(clampLimit(options.limit));
    return this.context.database
      .prepare(`${skillRegressionRunSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...values)
      .map((row) => mapSkillRegressionRun(row as Record<string, SQLOutputValue>));
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 20, 1), 100);
}
