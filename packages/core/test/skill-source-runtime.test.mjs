import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSkillSourceRuntimeFallbackPlan,
  buildSkillSourceRuntimePrompt,
  resolveSkillSourceRuntimeView,
} from "../dist/index.js";

function snapshot(overrides = {}) {
  return {
    id: overrides.id ?? "skill_source_review",
    workspaceId: "workspace_default",
    skillId: overrides.skillId ?? "review",
    sourceKind: "gstack-skill-directory",
    sourcePath: "skills/gstack-review/SKILL.md",
    upstreamName: "gstack",
    upstreamVersion: "1.58.3.0",
    upstreamSkillPath: "gstack-review/SKILL.md",
    sourceChecksum: "sha256:review",
    rawSkillMarkdown: overrides.rawSkillMarkdown ?? "---\nname: review\n---\n# Review\nUse the review flow.",
    agentMetadata: {
      displayName: "gstack-review",
      defaultPrompt: "Use gstack-review for this task.",
      allowImplicitInvocation: true,
    },
    referencedFiles: [{
      path: "references/checklist.md",
      kind: "reference",
      checksum: "sha256:checklist",
      sizeBytes: 32,
      includedInSnapshot: false,
    }],
    warnings: overrides.warnings ?? [{
      code: "host_specific_tool",
      severity: "info",
      message: "References host-specific behavior.",
      location: "SKILL.md:10",
    }],
    reviewStatus: "published",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

function compiledView(overrides = {}) {
  return {
    id: overrides.id ?? "skill_compiled_review",
    skillId: overrides.skillId ?? "review",
    sourceSnapshotId: overrides.sourceSnapshotId ?? "skill_source_review",
    createdAt: "2026-06-22T00:00:00.000Z",
    compilerVersion: "skill-optimizer-test",
    coreRulesMarkdown: overrides.coreRulesMarkdown ?? "Follow the compact review workflow.",
    lazyReferences: overrides.lazyReferences ?? [{
      id: "lazy_examples",
      title: "Review examples",
      kind: "example",
      sourceRef: "SKILL.md#examples",
      summary: "Example review outputs stay lazy.",
      tokenEstimate: 12,
      loadPolicy: "on_request",
    }],
    sourceMap: [{
      compiledRef: "coreRulesMarkdown",
      sourceRef: "SKILL.md#workflow",
      rationale: "Core workflow copied into compiled rules.",
    }],
    tokenEstimate: overrides.tokenEstimate ?? 36,
    fallbackPolicy: "original_on_error",
  };
}

test("skill source runtime prompt renders source text, metadata, inventory, and policy boundary", () => {
  const result = buildSkillSourceRuntimePrompt({ snapshot: snapshot() });

  assert.equal(result.context.loaded, true);
  assert.equal(result.context.runtimeViewKind, "original_source");
  assert.equal(result.context.optimizationMode, "no_operation");
  assert.equal(result.context.snapshotId, "skill_source_review");
  assert.equal(result.context.truncated, false);
  assert.equal(result.context.warningSeverities[0], "info");
  assert.equal(result.context.includedRefs.length, 1);
  assert.equal(result.context.deferredRefs.length, 1);
  assert.match(result.promptFragment, /Selected Skill Source Snapshot/);
  assert.match(result.promptFragment, /does not grant tools/);
  assert.match(result.promptFragment, /# Review/);
  assert.match(result.promptFragment, /Display name: gstack-review/);
  assert.match(result.promptFragment, /references\/checklist.md/);
});

test("skill source runtime prompt records truncation evidence", () => {
  const result = buildSkillSourceRuntimePrompt({
    snapshot: snapshot({ rawSkillMarkdown: "x".repeat(120) }),
    maxLoadedChars: 40,
  });

  assert.equal(result.context.loaded, true);
  assert.equal(result.context.sourceLengthChars, 120);
  assert.equal(result.context.loadedChars, 40);
  assert.equal(result.context.truncated, true);
  assert.match(result.promptFragment, /truncated for this run/);
});

test("skill source runtime prompt suppresses source text when error warnings exist", () => {
  const result = buildSkillSourceRuntimePrompt({
    snapshot: snapshot({
      warnings: [{
        code: "secret_reference",
        severity: "error",
        message: "Possible raw secret-like value appears in SKILL.md.",
      }],
    }),
  });

  assert.equal(result.context.loaded, false);
  assert.equal(result.context.runtimeViewKind, "original_source");
  assert.equal(result.context.blockedReason, "source_snapshot_has_error_warnings");
  assert.equal(result.promptFragment, undefined);
});

test("runtime resolver records metadata-only context when no source snapshot exists", () => {
  const result = resolveSkillSourceRuntimeView({ skillId: "review" });

  assert.equal(result.context.loaded, false);
  assert.equal(result.context.runtimeViewKind, "metadata_only");
  assert.equal(result.context.skillId, "review");
  assert.equal(result.context.blockedReason, "source_snapshot_missing");
  assert.equal(result.promptFragment, undefined);
});

test("runtime resolver keeps no_operation on original source even when compiled view exists", () => {
  const result = resolveSkillSourceRuntimeView({
    skillId: "review",
    snapshot: snapshot(),
    compiledView: compiledView(),
    optimizationMode: "no_operation",
  });

  assert.equal(result.context.runtimeViewKind, "original_source");
  assert.equal(result.context.compiledViewId, undefined);
  assert.match(result.promptFragment, /Selected Skill Source Snapshot/);
  assert.doesNotMatch(result.promptFragment, /Selected Skill Compiled Runtime View/);
});

test("runtime resolver can render compiled core plus deferred lazy references when policy allows", () => {
  const result = resolveSkillSourceRuntimeView({
    skillId: "review",
    snapshot: snapshot(),
    compiledView: compiledView(),
    optimizationMode: "auto_runtime_experimental",
  });

  assert.equal(result.context.loaded, true);
  assert.equal(result.context.runtimeViewKind, "compiled_view");
  assert.equal(result.context.compiledViewId, "skill_compiled_review");
  assert.equal(result.context.includedRefs[0].title, "Compiled core rules");
  assert.equal(result.context.deferredRefs[0].id, "lazy_examples");
  assert.match(result.promptFragment, /Selected Skill Compiled Runtime View/);
  assert.match(result.promptFragment, /Available Skill References/);
  assert.match(result.promptFragment, /does not grant tools/);
});

test("runtime resolver disables compiled context for unsupported runners", () => {
  const result = resolveSkillSourceRuntimeView({
    skillId: "review",
    snapshot: snapshot(),
    compiledView: compiledView(),
    optimizationMode: "auto_safe",
    runtimeSupportsCompiledContext: false,
  });

  assert.equal(result.context.loaded, false);
  assert.equal(result.context.runtimeViewKind, "disabled_for_runner");
  assert.equal(result.context.blockedReason, "runner_does_not_support_compiled_skill_context");
  assert.equal(result.context.deferredRefs.length, 1);
  assert.equal(result.promptFragment, undefined);
});

test("runtime fallback plan retries compiled missing references with original source", () => {
  const result = resolveSkillSourceRuntimeView({
    skillId: "review",
    snapshot: snapshot(),
    compiledView: compiledView(),
    optimizationMode: "auto_runtime_experimental",
  });

  const plan = buildSkillSourceRuntimeFallbackPlan(
    result.context,
    "Cannot continue because ref lazy_examples was not loaded.",
  );

  assert.equal(plan?.reasonCode, "compiled_missing_reference");
  assert.equal(plan?.fromRuntimeViewKind, "compiled_view");
  assert.equal(plan?.retryRuntimeViewKind, "original_source");
  assert.deepEqual(plan?.matchedRefIds, ["lazy_examples"]);
});

test("runtime fallback plan ignores original source failures", () => {
  const result = resolveSkillSourceRuntimeView({
    skillId: "review",
    snapshot: snapshot(),
    optimizationMode: "no_operation",
  });

  const plan = buildSkillSourceRuntimeFallbackPlan(result.context, "missing reference lazy_examples");

  assert.equal(plan, undefined);
});
