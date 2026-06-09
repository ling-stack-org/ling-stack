import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

test("sqlite channel workflow metadata migration is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-metadata-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      const column = database
        .prepare("PRAGMA table_info(channel_workflows)")
        .all()
        .find((row) => row.name === "metadata_json");
      assert.ok(column);
      assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 48 AND name = 'add_channel_workflow_metadata'").get());
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel workflow metadata round-trips and remains non-authoritative on corrupt JSON", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-metadata-"));
  let store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-09T00:00:00.000Z";
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow(
      {
        channelId: channel.id,
        title: "Graph workflow",
        objective: "Compile graph metadata",
        status: "ready",
        createdBy: "local-user",
        metadata: {
          workflowGraphId: "graph_demo",
          workflowGraphSchemaVersion: 1,
          termination: {
            success: "all_required_succeeded",
            onFailedRequiredNode: "fail_workflow",
            onApprovalDenied: "block_for_user",
            maxTicks: 20,
          },
          maxParallelSteps: 2,
        },
      },
      now,
    );
    assert.deepEqual(workflow.metadata, {
      workflowGraphId: "graph_demo",
      workflowGraphSchemaVersion: 1,
      termination: {
        success: "all_required_succeeded",
        onFailedRequiredNode: "fail_workflow",
        onApprovalDenied: "block_for_user",
        maxTicks: 20,
      },
      maxParallelSteps: 2,
    });

    const cleared = store.updateChannelWorkflow(workflow.id, { metadata: null }, "2026-06-09T00:01:00.000Z");
    assert.equal(cleared?.metadata, undefined);
    const updated = store.updateChannelWorkflow(workflow.id, {
      metadata: {
        workflowGraphId: "graph_repaired",
        workflowGraphSchemaVersion: 1,
      },
    }, "2026-06-09T00:02:00.000Z");
    assert.equal(updated?.metadata?.workflowGraphId, "graph_repaired");

    const paths = resolveRuntimePaths(cwd);
    store.close();
    const database = new DatabaseSync(paths.databasePath);
    try {
      database.prepare("UPDATE channel_workflows SET metadata_json = ? WHERE id = ?").run("{not json", workflow.id);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal(store.getChannelWorkflow(workflow.id)?.metadata, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
