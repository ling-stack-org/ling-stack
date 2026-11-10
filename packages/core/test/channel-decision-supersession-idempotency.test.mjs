import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  ChannelDecisionStatusConflictError,
  ChannelDecisionSupersessionConflictError,
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "../dist/index.js";

const CREATED_AT = "2026-05-28T01:00:00.000Z";
const SUPERSEDED_AT = "2026-05-28T01:01:00.000Z";

test("sqlite decision supersession is atomic and idempotent across concurrent stores", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-decision-supersession-"));
  let setupStore = createSqliteRunStore(cwd);
  try {
    const databasePath = setupStore.paths.databasePath;
    const channel = setupStore.createChannel({ name: "Engineering", boundPath: cwd }, CREATED_AT);
    const source = setupStore.createChannelDecision({
      channelId: channel.id,
      title: "Original decision",
      decision: "Use protocol A.",
      createdBy: "local-user",
    }, CREATED_AT);
    setupStore.close();
    setupStore = undefined;

    const input = {
      channelId: channel.id,
      supersedesDecisionId: source.id,
      title: "Replacement decision",
      decision: "Use protocol B.",
      rationale: "The replacement is safe.",
      alternatives: ["Keep protocol A"],
      createdBy: "local-user",
    };
    const workerData = {
      cwd,
      moduleUrl: new URL("../dist/index.js", import.meta.url).href,
      now: SUPERSEDED_AT,
      input,
    };
    const workers = [createDecisionWorker(workerData), createDecisionWorker(workerData)];
    try {
      await Promise.all(workers.map(async (worker) => {
        assert.equal((await readWorkerMessage(worker)).type, "ready");
      }));
      const resultPromises = workers.map((worker) => readWorkerMessage(worker));
      workers.forEach((worker) => worker.postMessage("go"));
      const results = await Promise.all(resultPromises);
      assert.equal(results[0].decisionId, results[1].decisionId);
      assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }

    const verifyStore = createSqliteRunStore(cwd);
    try {
      assert.equal(verifyStore.getChannelDecision(source.id).status, "superseded");
      const successors = verifyStore.listChannelDecisions({ channelId: channel.id, limit: 10 })
        .filter((decision) => decision.supersedesDecisionId === source.id);
      assert.equal(successors.length, 1);
      assert.equal(successors[0].status, "active");
      assert.throws(
        () => verifyStore.createOrReuseSupersedingChannelDecision({
          ...input,
          decision: "Use a conflicting protocol C.",
        }, "2026-05-28T01:02:00.000Z"),
        (error) => error instanceof ChannelDecisionSupersessionConflictError &&
          error.code === "decision_supersession_conflict" &&
          error.successorDecisionId === successors[0].id,
      );
    } finally {
      verifyStore.close();
    }

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const index = database.prepare("PRAGMA index_list(channel_decisions)").all()
        .find((candidate) => candidate.name === "idx_channel_decisions_supersedes_unique");
      assert.equal(index?.unique, 1);
      assert.equal(index?.partial, 1);
    } finally {
      database.close();
    }
  } finally {
    setupStore?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejecting a stale decision cannot overwrite a committed supersession", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-decision-reject-cas-"));
  const supersedingStore = createSqliteRunStore(cwd);
  const rejectingStore = createSqliteRunStore(cwd);
  try {
    const channel = supersedingStore.createChannel({ name: "Engineering", boundPath: cwd }, CREATED_AT);
    const source = supersedingStore.createChannelDecision({
      channelId: channel.id,
      title: "Original decision",
      decision: "Use protocol A.",
      createdBy: "local-user",
    }, CREATED_AT);
    const replacement = supersedingStore.createOrReuseSupersedingChannelDecision({
      channelId: channel.id,
      supersedesDecisionId: source.id,
      title: "Replacement decision",
      decision: "Use protocol B.",
      createdBy: "local-user",
    }, SUPERSEDED_AT).decision;

    assert.throws(
      () => rejectingStore.rejectActiveChannelDecision(
        source.id,
        {},
        "2026-05-28T01:02:00.000Z",
      ),
      (error) => error instanceof ChannelDecisionStatusConflictError &&
        error.code === "decision_status_conflict" &&
        error.decisionId === source.id &&
        error.expectedStatus === "active" &&
        error.actualStatus === "superseded",
    );
    assert.equal(rejectingStore.getChannelDecision(source.id).status, "superseded");
    assert.equal(rejectingStore.getChannelDecision(replacement.id).status, "active");
  } finally {
    rejectingStore.close();
    supersedingStore.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("decision supersession migration keeps the first active claim and rejects duplicate successors", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-decision-supersession-migration-"));
  let setupStore = createSqliteRunStore(cwd);
  try {
    const databasePath = setupStore.paths.databasePath;
    const channel = setupStore.createChannel({ name: "Engineering", boundPath: cwd }, CREATED_AT);
    const source = setupStore.createChannelDecision({
      channelId: channel.id,
      title: "Original decision",
      decision: "Use protocol A.",
      createdBy: "local-user",
    }, CREATED_AT);
    setupStore.close();
    setupStore = undefined;

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP INDEX idx_channel_decisions_supersedes_unique;
        DELETE FROM schema_migrations WHERE version = 129;
      `);
      legacy.prepare("UPDATE channel_decisions SET status = 'superseded' WHERE id = ?").run(source.id);
      const insert = legacy.prepare(`
        INSERT INTO channel_decisions (
          id, workspace_id, channel_id, source_item_id, source_task_id, source_run_id,
          title, decision, rationale, alternatives_json, status, supersedes_decision_id,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, '', '[]', 'active', ?, 'local-user', ?, ?)
      `);
      insert.run(
        "decision_legacy_first",
        DEFAULT_WORKSPACE_ID,
        channel.id,
        "First replacement",
        "First writer wins.",
        source.id,
        "2026-05-28T01:01:00.000Z",
        "2026-05-28T01:01:00.000Z",
      );
      insert.run(
        "decision_legacy_duplicate",
        DEFAULT_WORKSPACE_ID,
        channel.id,
        "Duplicate replacement",
        "This claim must become rejected.",
        source.id,
        "2026-05-28T01:02:00.000Z",
        "2026-05-28T01:02:00.000Z",
      );
    } finally {
      legacy.close();
    }

    const migrated = createSqliteRunStore(cwd);
    try {
      const first = migrated.getChannelDecision("decision_legacy_first");
      const duplicate = migrated.getChannelDecision("decision_legacy_duplicate");
      assert.equal(first.supersedesDecisionId, source.id);
      assert.equal(first.status, "active");
      assert.equal(duplicate.supersedesDecisionId, undefined);
      assert.equal(duplicate.status, "rejected");
      assert.equal(
        migrated.listChannelDecisions({ channelId: channel.id, status: "active", limit: 10 })
          .filter((decision) => decision.supersedesDecisionId === source.id).length,
        1,
      );
    } finally {
      migrated.close();
    }
  } finally {
    setupStore?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createDecisionWorker(workerData) {
  return new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    void import(workerData.moduleUrl).then(({ createSqliteRunStore }) => {
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ type: "ready" });
      parentPort.once("message", () => {
        try {
          const result = store.createOrReuseSupersedingChannelDecision(workerData.input, workerData.now);
          parentPort.postMessage({
            type: "result",
            decisionId: result.decision.id,
            reused: result.reused,
          });
        } catch (error) {
          parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
        } finally {
          store.close();
        }
      });
    }).catch((error) => {
      parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  `, { eval: true, workerData });
}

async function readWorkerMessage(worker) {
  const [message] = await once(worker, "message");
  if (message.type === "error") throw new Error(message.message);
  return message;
}
