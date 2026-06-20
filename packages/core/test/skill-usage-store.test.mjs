import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

async function withStore(prefix, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      await fn(store, cwd);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function runInput(cwd, overrides = {}) {
  return {
    id: overrides.id ?? "run_skill_usage_test",
    cwd,
    taskId: overrides.taskId ?? "task_skill_usage_test",
    channelId: overrides.channelId ?? "channel_skill_usage_test",
    teammateId: overrides.teammateId ?? "teammate_skill_usage_test",
    selectedSkillId: overrides.selectedSkillId ?? "skill_usage_test",
    providerName: "Static",
    providerModel: "static-model",
    taskSnapshot: { title: "Skill usage test" },
    providerSnapshot: { provider: "static", model: "static-model" },
    requestSnapshot: { requestedSkillId: overrides.selectedSkillId ?? "skill_usage_test" },
    createdAt: overrides.createdAt ?? "2026-06-20T00:00:00.000Z",
  };
}

test("sqlite skill usage records selected skill run lifecycle and rebuilds stats", async () => {
  await withStore("ling-stack-skill-usage-", async (store, cwd) => {
    const run = store.createRun(runInput(cwd));
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "system",
      now: "2026-06-20T00:00:01.000Z",
      startedAt: "2026-06-20T00:00:01.000Z",
    });
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_failed",
      actor: "system",
      now: "2026-06-20T00:00:02.000Z",
      endedAt: "2026-06-20T00:00:02.000Z",
      errorMessage: "Model error",
    });

    const events = store.listSkillUsageEvents({ skillId: "skill_usage_test", limit: 10 });
    assert.deepEqual(events.map((event) => event.kind).sort(), ["failed", "selected", "started"]);

    const stats = store.listSkillUsageStats({ skillId: "skill_usage_test" })[0];
    assert.equal(stats.skillId, "skill_usage_test");
    assert.equal(stats.useCount, 1);
    assert.equal(stats.failureCount, 1);
    assert.equal(stats.lastFailureAt, "2026-06-20T00:00:02.000Z");
  });
});

test("sqlite skill usage can record candidate draft and publish events", async () => {
  await withStore("ling-stack-skill-usage-candidate-", async (store) => {
    store.appendSkillUsageEvent({
      candidateId: "skill_candidate_usage",
      kind: "draft_created",
      reason: "Created import draft.",
    }, "2026-06-20T00:00:00.000Z");
    store.appendSkillUsageEvent({
      candidateId: "skill_candidate_usage",
      skillId: "published_skill",
      kind: "published",
      reason: "Published import draft.",
    }, "2026-06-20T00:01:00.000Z");

    assert.deepEqual(
      store.listSkillUsageEvents({ candidateId: "skill_candidate_usage", limit: 10 }).map((event) => event.kind),
      ["published", "draft_created"],
    );
  });
});
