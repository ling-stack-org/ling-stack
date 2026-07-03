import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildSkillRegressionRunInput,
  canPromoteSkillOptimizationAutoSafe,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

const fixture = {
  id: "real_review_task_fixture",
  skillId: "review",
  source: "real_task",
  prompt: "Review this pull request and report regressions first.",
  expectedSelectedSkillId: "review",
  expectedSuccessMarkers: ["Findings", "Verification"],
  forbiddenOutputMarkers: ["approval bypass"],
  maxApprovalCount: 0,
  maxApprovalRisk: "low",
};

test("skill regression harness gates auto_safe on passing A/B/C evidence", async () => {
  const input = buildSkillRegressionRunInput({
    skillId: "review",
    suiteId: "skill-context-p3-review",
    fixtures: [fixture],
    observations: [
      observation("original_source", { tokenEstimate: 1200 }),
      observation("compiled_view", { tokenEstimate: 650 }),
      observation("compressed_routing_compiled_view", { tokenEstimate: 600 }),
    ],
    now: "2026-07-03T00:00:00.000Z",
  });

  assert.equal(input.lifecycleVerdict, "safe_for_core_lazy");
  assert.equal(input.autoSafeEligible, true);
  assert.equal(input.summary.tokenReductionRatio > 0.15, true);
  assert.equal(input.summary.failedCount, 0);

  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-regression-safe-"));
  const store = createSqliteRunStore(cwd);
  try {
    const run = store.createSkillRegressionRun(input, "2026-07-03T00:01:00.000Z");
    assert.equal(run.guardrails.authority, "shadow");
    assert.equal(run.guardrails.canMutateSkillDefinition, false);
    assert.equal(run.guardrails.canChangeRuntimeAuthority, false);
    assert.equal(canPromoteSkillOptimizationAutoSafe(run), true);
    assert.deepEqual(store.listSkillRegressionRuns({ skillId: "review" }).map((item) => item.id), [run.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill regression harness blocks auto_safe on missing deferred reference", () => {
  const input = buildSkillRegressionRunInput({
    skillId: "review",
    fixtures: [fixture],
    observations: [
      observation("original_source", { tokenEstimate: 1200 }),
      observation("compiled_view", {
        tokenEstimate: 650,
        fallbackPlan: {
          reasonCode: "compiled_missing_reference",
          fromRuntimeViewKind: "compiled_view",
          retryRuntimeViewKind: "original_source",
          message: "Compiled context missed a required checklist reference.",
          matchedRefIds: ["lazy_checklist"],
        },
        errorMessage: "Reference lazy_checklist was not loaded.",
        runtimeContext: compiledContext(),
      }),
      observation("compressed_routing_compiled_view", { tokenEstimate: 600 }),
    ],
    now: "2026-07-03T00:00:00.000Z",
  });

  assert.equal(input.lifecycleVerdict, "needs_manual_review");
  assert.equal(input.autoSafeEligible, false);
  assert.equal(input.summary.missingReferenceRegressionCount, 1);
  const compiledResult = input.results.find((result) => result.mode === "compiled_view");
  assert.equal(compiledResult?.passed, false);
  assert.equal(compiledResult?.findings[0]?.kind, "missing_reference_regression");
  assert.deepEqual(compiledResult?.findings[0]?.sourceRefs, ["SKILL.md#checklist"]);
});

test("sqlite skill regression migration creates persistent P3 result table", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-regression-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_regression_runs'").get());
      assert.ok(
        database
          .prepare("SELECT version FROM schema_migrations WHERE version = 93 AND name = 'create_skill_regression_runs'")
          .get(),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function observation(mode, overrides = {}) {
  return {
    fixtureId: fixture.id,
    mode,
    selectedSkillId: "review",
    outputText: "Findings\n- No regressions found.\n\nVerification\n- Focused suite passed.",
    completed: true,
    approvalCount: 0,
    maxApprovalRisk: "low",
    clarificationCount: 0,
    latencyMs: 100,
    runtimeContext: overrides.runtimeContext ?? {
      loaded: true,
      runtimeViewKind: mode === "original_source" ? "original_source" : "compiled_view",
      skillId: "review",
      tokenEstimate: overrides.tokenEstimate ?? 800,
      includedRefs: [],
      deferredRefs: [],
      materializedRefs: [],
    },
    ...overrides,
  };
}

function compiledContext() {
  return {
    loaded: true,
    runtimeViewKind: "compiled_view",
    skillId: "review",
    snapshotId: "skill_source_review",
    compiledViewId: "skill_compiled_review",
    tokenEstimate: 650,
    includedRefs: [],
    deferredRefs: [
      {
        id: "lazy_checklist",
        title: "Review checklist",
        kind: "reference",
        sourceRef: "SKILL.md#checklist",
        summary: "Checklist used to validate review findings.",
        tokenEstimate: 20,
        loadPolicy: "on_request",
      },
    ],
    materializedRefs: [],
  };
}
