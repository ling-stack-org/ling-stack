import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "@ling-stack/api-client";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server persists the Work Item to Device Fabric owner mapping and replays it after restart", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-app-server-device-bridge-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const token = randomUUID();
  const createDaemon = () => createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, authToken: token }, {
    storeFactory(workspace) {
      return createSqliteRunStore(workspace, resolveStoragePaths(workspace, { homeDir: root, env: {}, workspaceStateLocation: "repo-local" }).workspace);
    },
  });
  let daemon = createDaemon();
  const connect = async () => {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = new URL(`ws://127.0.0.1:${address.port}/app-server/rpc`);
    url.searchParams.set("cwd", cwd);
    const client = new LingAppServerClient({
      url: url.href, clientInfo: { name: "Device bridge test", version: "1" }, requiredCapabilities: ["workItem.device"],
      createSocket: address => new WebSocket(address, { headers: { Authorization: `Bearer ${token}` } }) as unknown as LingAppServerSocket,
    });
    await client.connect();
    t.after(() => client.close());
    return client;
  };
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });

  await daemon.start();
  const client = await connect();
  const created = await client.createWorkItem({ cwd, sourceType: "device_task_graph_node", sourceId: "graph-rpc/node-rpc", title: "Device RPC" });
  const binding = await client.bindWorkItemDevice({
    cwd, workItemId: created.workItem.workItemId, graphId: "graph-rpc", graphNodeId: "node-rpc", graphRevision: 2,
    ownerHostId: "host-rpc", ownerRouteGeneration: 7, workUnitId: "unit-rpc", attemptId: "attempt-rpc",
    expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "bind-rpc",
  });
  assert.equal(binding.binding.status, "bound");
  const unknown = await client.recordWorkItemDeviceReceipt({
    cwd, workItemId: created.workItem.workItemId, bindingId: binding.binding.bindingId, expectedBindingRevision: binding.binding.revision,
    expectedWorkItemRevision: Number(created.workItem.revision), ownerHostId: "host-rpc", ownerRouteGeneration: 7,
    workUnitId: "unit-rpc", attemptId: "attempt-rpc", status: "unknown", resultRef: "journal-rpc-unknown", idempotencyKey: "receipt-rpc",
  });
  assert.equal(unknown.binding.status, "unknown");
  const beforeRestart = await client.readWorkItemDevice(created.workItem.workItemId);
  assert.equal(beforeRestart.bindings[0]?.receipt?.resultRef, "journal-rpc-unknown");
  client.close();
  await daemon.stop();
  daemon = createDaemon();
  await daemon.start();
  const resumed = await connect();
  const afterRestart = await resumed.readWorkItemDevice(created.workItem.workItemId);
  assert.equal(afterRestart.bindings[0]?.status, "unknown");
  assert.equal(afterRestart.bindings[0]?.ownerHostId, "host-rpc");
});
