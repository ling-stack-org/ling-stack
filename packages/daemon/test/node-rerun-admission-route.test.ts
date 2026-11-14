import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { parseRunRoute } from "../dist/server/routes.js";
import { routeRequest } from "../dist/server/router.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

test("the Daemon routes node rerun admission under the source Run", () => {
  assert.deepEqual(parseRunRoute("/runs/run%2Frerun/node-rerun/admission"), {
    kind: "node-rerun-admission",
    runId: "run/rerun",
  });
  assert.equal(parseRunRoute("/runs/run%2Frerun/node-rerun"), undefined);
  assert.equal(parseRunRoute("/runs/run%2Frerun/node-rerun/admission/extra"), undefined);
});

test("node rerun admission keeps workspace Origin authorization at the router boundary", async t => {
  const cwd = "/tmp/ling-node-rerun-route-workspace";
  const storeRegistry = new RunStoreRegistry(() => {
    throw new Error("the Origin guard must run before Store initialization");
  }, { trustedWorkspaceRoots: [cwd] });
  const context = {
    config: { host: "127.0.0.1", port: 0, maxBodyBytes: 1_048_576 },
    engineManagement: { handle: async () => false },
    remoteAccess: { handleManagementRequest: async () => false },
    storeRegistry,
    activeRuns: new ActiveRunRegistry(),
  } as never;
  const server = createServer((request, response) => {
    void routeRequest(request, response, context).catch(error => {
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    storeRegistry.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/run-1/node-rerun/admission`);
  url.searchParams.set("cwd", cwd);
  const request = { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" };
  const forbidden = await fetch(url, request);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    error: "forbidden_origin",
    message: "Workspace file actions are only available from local Ling Stack pages.",
  });

  const local = await fetch(url, { ...request, headers: { ...request.headers, origin: "http://127.0.0.1:5173" } });
  assert.equal(local.status, 400);
  assert.deepEqual(await local.json(), {
    error: "node_rerun_admission_invalid_request",
    message: "The node rerun admission request is invalid.",
  });
});
