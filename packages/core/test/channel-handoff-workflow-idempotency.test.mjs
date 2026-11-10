import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore } from "../dist/index.js";

const NOW = "2026-05-26T01:00:00.000Z";

test("sqlite handoff workflow creation is atomic and idempotent across concurrent stores", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-handoff-workflow-idempotency-"));
  let setupStore = createSqliteRunStore(cwd);
  try {
    const databasePath = setupStore.paths.databasePath;
    const { channel, handoff } = createHandoffFixture(setupStore, cwd, NOW);
    setupStore.close();
    setupStore = undefined;

    const workerData = {
      cwd,
      moduleUrl: new URL("../dist/index.js", import.meta.url).href,
      now: NOW,
      input: handoffWorkflowInput(channel.id, handoff.id),
    };
    const workers = [createHandoffWorkflowWorker(workerData), createHandoffWorkflowWorker(workerData)];
    try {
      await Promise.all(workers.map(async (worker) => {
        assert.equal((await readWorkerMessage(worker)).type, "ready");
      }));
      const resultPromises = workers.map((worker) => readWorkerMessage(worker));
      workers.forEach((worker) => worker.postMessage("go"));
      const results = await Promise.all(resultPromises);
      assert.equal(results[0].workflowId, results[1].workflowId);
      assert.equal(results[0].workflowStepId, results[1].workflowStepId);
      assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }

    const verifyStore = createSqliteRunStore(cwd);
    try {
      const workflows = verifyStore.listChannelWorkflows({ channelId: channel.id, limit: 10 });
      assert.equal(workflows.length, 1);
      assert.equal(verifyStore.listChannelWorkflowSteps({ workflowId: workflows[0].id, complete: true }).length, 1);
    } finally {
      verifyStore.close();
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const index = database.prepare("PRAGMA index_list(channel_workflows)").all()
        .find((candidate) => candidate.name === "idx_channel_workflows_source_handoff_unique");
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

test("sqlite handoff workflow idempotency migration preserves duplicate history and selects the first workflow", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-handoff-workflow-migration-"));
  let setupStore = createSqliteRunStore(cwd);
  try {
    const databasePath = setupStore.paths.databasePath;
    const { channel, handoff } = createHandoffFixture(setupStore, cwd, NOW);
    setupStore.close();
    setupStore = undefined;

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP INDEX idx_channel_workflows_source_handoff_unique;
        DELETE FROM schema_migrations WHERE version = 128;
      `);
      const insertWorkflow = legacy.prepare(`
        INSERT INTO channel_workflows (
          id, workspace_id, channel_id, source_handoff_id, title, objective,
          status, created_by, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'local-user', NULL, ?, ?)
      `);
      insertWorkflow.run(
        "workflow_legacy_first", DEFAULT_WORKSPACE_ID, channel.id, handoff.id,
        "First workflow", "First writer wins.",
        "2026-05-26T01:01:00.000Z", "2026-05-26T01:01:00.000Z",
      );
      insertWorkflow.run(
        "workflow_legacy_duplicate", DEFAULT_WORKSPACE_ID, channel.id, handoff.id,
        "Duplicate workflow", "Preserve this row without the workflow-level handoff claim.",
        "2026-05-26T01:02:00.000Z", "2026-05-26T01:02:00.000Z",
      );
    } finally {
      legacy.close();
    }

    const migrated = createSqliteRunStore(cwd);
    try {
      assert.equal(migrated.getChannelWorkflow("workflow_legacy_first").sourceHandoffId, handoff.id);
      assert.equal(migrated.getChannelWorkflow("workflow_legacy_duplicate").sourceHandoffId, undefined);
      const result = migrated.createOrReuseChannelHandoffWorkflow(
        handoffWorkflowInput(channel.id, handoff.id),
        "2026-05-26T01:03:00.000Z",
      );
      assert.equal(result.reused, true);
      assert.equal(result.workflow.id, "workflow_legacy_first");
      assert.equal(result.workflowStep.sourceHandoffId, handoff.id);
      assert.equal(migrated.listChannelWorkflows({ channelId: channel.id, limit: 10 }).length, 2);
    } finally {
      migrated.close();
    }
  } finally {
    setupStore?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createHandoffFixture(store, cwd, now) {
  const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
  const handoff = store.createChannelHandoff({
    channelId: channel.id,
    fromParticipantId: "tian",
    fromParticipantLabel: "Tian",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    reason: "Need implementation",
    requiredInput: "Approved plan",
    expectedOutput: "Patch",
    createdBy: "local-user",
  }, now);
  return { channel, handoff };
}

function handoffWorkflowInput(channelId, sourceHandoffId) {
  return {
    channelId,
    sourceHandoffId,
    workflow: {
      title: "Engineer handoff",
      objective: "Complete the implementation handoff.",
      createdBy: "local-user",
    },
    workflowStep: {
      title: "Implement",
      prompt: "Create the patch.",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
    },
  };
}

function createHandoffWorkflowWorker(workerData) {
  return new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    void import(workerData.moduleUrl).then(({ createSqliteRunStore }) => {
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ type: "ready" });
      parentPort.once("message", () => {
        try {
          const result = store.createOrReuseChannelHandoffWorkflow(workerData.input, workerData.now);
          parentPort.postMessage({
            type: "result",
            workflowId: result.workflow.id,
            workflowStepId: result.workflowStep.id,
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
  if (message.type === "error") {
    throw new Error(message.message);
  }
  return message;
}
