import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
} from "../dist/index.js";

test("sqlite store creates the default approval policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const store = createSqliteRunStore(cwd);
  try {
    const policy = store.getApprovalPolicy();

    assert.equal(policy.workspaceId, "workspace_default");
    assert.deepEqual(policy.toolDecisions, defaultApprovalToolDecisions);
    assert.deepEqual(policy.allowedWritePaths, defaultAllowedWritePaths);
    assert.equal(policy.createdAt, policy.updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store merges and persists approval policy updates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const updatedAt = "2026-05-21T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const updated = store.updateApprovalPolicy(
      {
        toolDecisions: {
          bash: "allow",
          write: "deny",
        },
        allowedWritePaths: [".", "docs"],
      },
      updatedAt,
    );

    assert.equal(updated.toolDecisions.read, "allow");
    assert.equal(updated.toolDecisions.bash, "allow");
    assert.equal(updated.toolDecisions.edit, "ask");
    assert.equal(updated.toolDecisions.write, "deny");
    assert.deepEqual(updated.allowedWritePaths, [".", "docs"]);
    assert.equal(updated.updatedAt, updatedAt);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getApprovalPolicy();

    assert.equal(persisted.toolDecisions.bash, "allow");
    assert.equal(persisted.toolDecisions.write, "deny");
    assert.deepEqual(persisted.allowedWritePaths, [".", "docs"]);
    assert.equal(persisted.updatedAt, updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
