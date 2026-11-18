import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";

test("quiet hours can be configured, preserved by partial updates and explicitly cleared", async t => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-companion-policy-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/companions`;
  const query = `?cwd=${encodeURIComponent(cwd)}`;
  const created = await fetch(`${base}${query}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teammateId: "teammate_builtin_engineer", displayName: "Yui",
      behaviorPolicy: { proactiveEnabled: false, cooldownMs: 900_000, quietHours: [22, 8] } }) });
  assert.equal(created.status, 201);
  const { companion } = await created.json();
  const patch = (policy: unknown) => fetch(`${base}/${companion.id}${query}`, { method: "PATCH",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ behaviorPolicy: policy }) });
  const partial = await patch({ proactiveEnabled: true });
  assert.deepEqual((await partial.json()).companion.behaviorPolicy, { proactiveEnabled: true, cooldownMs: 900_000, quietHours: [22, 8] });
  const cleared = await patch({ quietHours: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).companion.behaviorPolicy, { proactiveEnabled: true, cooldownMs: 900_000 });
  assert.equal((await patch({ quietHours: [24, 8] })).status, 400);
  assert.equal((await patch({ quietHours: [22] })).status, 400);
});
