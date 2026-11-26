import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "@ling-stack/api-client";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server reserves device owner writes for the operator and replays them to a scoped controller", { timeout: 15_000 }, async t => {
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
  const connect = async (bearer: string = token) => {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = new URL(`ws://127.0.0.1:${address.port}/app-server/rpc`);
    url.searchParams.set("cwd", cwd);
    const client = new LingAppServerClient({
      url: url.href, clientInfo: { name: "Device bridge test", version: "1" }, requiredCapabilities: ["workItem.device"],
      createSocket: address => new WebSocket(address, { headers: { Authorization: `Bearer ${bearer}` } }) as unknown as LingAppServerSocket,
    });
    await client.connect();
    t.after(() => client.close());
    return client;
  };
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });

  await daemon.start();
  const client = await connect();
  const created = await client.createWorkItem({ cwd, sourceType: "device_task_graph_node", sourceId: "graph-rpc/node-rpc", title: "Device RPC" });
  const secret = randomBytes(32).toString("hex");
  const { grant } = await client.createGrant({
    subject: { kind: "workItem", id: created.workItem.workItemId }, scopes: ["observe", "control"],
    label: "Device Work Item controller", credentialSha256: createHash("sha256").update(secret).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "device-work-item-controller",
  });
  const controllerBearer = `las1.${grant.grantId}.${secret}`;
  const controller = await connect(controllerBearer);
  const bindInput = {
    cwd, workItemId: created.workItem.workItemId, graphId: "graph-rpc", graphNodeId: "node-rpc", graphRevision: 2,
    ownerHostId: "host-rpc", ownerRouteGeneration: 7, workUnitId: "unit-rpc", attemptId: "attempt-rpc",
    expectedWorkItemRevision: Number(created.workItem.revision), idempotencyKey: "bind-rpc",
  };
  const binding = await client.bindWorkItemDevice(bindInput);
  assert.equal(binding.binding.status, "bound");
  const receiptInput = {
    cwd, workItemId: created.workItem.workItemId, bindingId: binding.binding.bindingId, expectedBindingRevision: binding.binding.revision,
    expectedWorkItemRevision: Number(created.workItem.revision), ownerHostId: "host-rpc", ownerRouteGeneration: 7,
    workUnitId: "unit-rpc", attemptId: "attempt-rpc", status: "unknown" as const, resultRef: "journal-rpc-unknown", idempotencyKey: "receipt-rpc",
  };
  await assert.rejects(controller.recordWorkItemDeviceReceipt(receiptInput), { code: "capability_denied" });
  await assert.rejects(controller.bindWorkItemDevice(bindInput), { code: "capability_denied" });
  const { methods } = await controller.getCapabilities();
  assert.ok(methods.includes("workItem/device/read"));
  assert.ok(!methods.includes("workItem/device/bind"));
  assert.ok(!methods.includes("workItem/device/receipt"));
  assert.deepEqual((await controller.readWorkItemDevice(created.workItem.workItemId)).bindings, [binding.binding]);
  const unknown = await client.recordWorkItemDeviceReceipt(receiptInput);
  assert.equal(unknown.binding.status, "unknown");
  const beforeRestart = await client.readWorkItemDevice(created.workItem.workItemId);
  assert.equal(beforeRestart.bindings[0]?.receipt?.resultRef, "journal-rpc-unknown");
  controller.close();
  client.close();
  await daemon.stop();
  daemon = createDaemon();
  await daemon.start();
  const resumed = await connect(controllerBearer);
  const afterRestart = await resumed.readWorkItemDevice(created.workItem.workItemId);
  assert.equal(afterRestart.bindings[0]?.status, "unknown");
  assert.equal(afterRestart.bindings[0]?.ownerHostId, "host-rpc");
});
