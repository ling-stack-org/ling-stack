import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("companion routes reject foreign origins and unknown workspaces before reading or mutating", async t => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-companion-access-"));
  const store = createSqliteRunStore(cwd);
  const companion = store.createCompanion({ teammateId: "teammate_builtin_engineer",
    displayName: "Local companion" }, new Date().toISOString());
  let opened = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory(root) { opened++; assert.equal(root, cwd); return store; },
  });
  t.after(async () => {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const local = await fetch(`${baseUrl}/companions?cwd=${encodeURIComponent(cwd)}`, {
    headers: { Origin: "http://localhost:4173" }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(local.status, 200);
  assert.equal((await local.json()).companions[0].id, companion.id);
  const initial = opened;
  const path = `/companions/${companion.id}`;
  const routes = [
    ["/companions", "GET"], ["/companions", "POST"],
    [path, "GET"], [path, "PATCH"], [path, "DELETE"],
    [`${path}/state`, "GET"], [`${path}/events`, "GET"],
    [`${path}/interactions`, "POST"], [`${path}/messages`, "GET"],
    [`${path}/messages`, "POST"], [`${path}/messages/stream`, "POST"],
    [`${path}/proactive`, "POST"],
  ] as const;
  for (const [route, method] of routes) {
    for (const [origin, root, error] of [
      ["https://foreign.example.invalid", cwd, "forbidden_origin"],
      ["null", cwd, "forbidden_origin"],
      ["http://localhost:4173", resolve(cwd, "..", "untrusted-companion-workspace"), "workspace_not_trusted"],
    ]) {
      const response = await fetch(`${baseUrl}${route}?cwd=${encodeURIComponent(root)}`, {
        method, headers: { Origin: origin, "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ displayName: "Foreign companion",
          teammateId: companion.teammateId, body: "Foreign message", type: "presence_changed", force: true }) }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 403, `${method} ${route} ${origin}`);
      assert.equal((await response.json()).error, error);
    }
  }
  assert.equal(opened, initial);
  assert.equal(store.getCompanion(companion.id)?.status, "active");
  assert.equal(store.getCompanion(companion.id)?.displayName, "Local companion");
  assert.equal(store.listCompanions().length, 1);
  assert.equal(store.listTeammateDirectMessages({ teammateId: companion.teammateId }).length, 0);
  assert.equal(store.listCompanionEvents({ companionId: companion.id }).length, 0);
});
