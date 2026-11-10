import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { publishManualMcpMetadata } from "../dist/features/mcp/metadata-publication.js";

test("MCP committed metadata remains a successful receipt when live notification throws", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-mcp-notification-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { userRootDir: resolve(directory, "home"), env: {} }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  const emitWarning = process.emitWarning;
  const warnings = [];
  process.emitWarning = (...args) => { warnings.push(args); };
  try {
    const now = "2026-10-09T00:00:00.000Z";
    store.createMcpServer({ id: "notification_fixture", displayName: "Fixture",
      transport: { type: "stdio", command: "fixture", args: [], env: {}, secretEnvRefs: {} } }, now);
    const snapshot = { serverId: "notification_fixture", status: "ready", checkedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z", missingSecretRefs: [],
      authStatus: { kind: "not_required", refs: [], missingRefs: [] } };
    let notificationAttempts = 0;
    const result = await publishManualMcpMetadata({
      store, serverId: snapshot.serverId, kind: "check", cwd,
      secretResolver: createCompositeSecretResolver({ env: {} }),
      broker: { async checkServer() { return { statusSnapshot: snapshot }; } },
      hub: { publish(event) {
        notificationAttempts++;
        assert.equal(store.getMcpStatusSnapshot(snapshot.serverId).status, "ready");
        assert.equal(store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID), event.seq);
        throw new Error("fixture_listener_private_detail_must_not_leak");
      } },
    });
    assert.equal(result.published, true);
    assert.equal(notificationAttempts, 1);
    assert.deepEqual(result.statusSnapshot, snapshot);
    assert.equal(store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }).length, 1);
    assert.equal(warnings.length, 1, "notification failure must have a safe operational diagnostic");
    assert.equal(warnings[0][1].code, "mcp_metadata_live_notification_failed");
    assert.equal(JSON.stringify(warnings).includes("private_detail"), false);
  } finally {
    process.emitWarning = emitWarning;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
