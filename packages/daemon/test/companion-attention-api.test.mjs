import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";

test("companion attention endpoint returns a workspace projection", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-companion-attention-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store },
  );
  t.after(async () => {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/companion-attention?cwd=" + encodeURIComponent(cwd);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const projection = await response.json();
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.cwd, cwd);
  assert.ok(Array.isArray(projection.items));
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});
