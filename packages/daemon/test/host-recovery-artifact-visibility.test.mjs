import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

const contentTypes = ["application/vnd.ling.native-file-mutation-completion+json",
  "application/vnd.ling.host-compaction-resource-boundary+json"];

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-private-host-artifacts-"));
  const store = createSqliteRunStore(cwd), now = new Date().toISOString();
  const run = store.createRun({ id: "private-artifact-run", cwd, taskId: "fixture", providerName: "fixture",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.markRunStarted(run.id, now);
  store.markRunSucceeded(run.id, now);
  for (const [index, contentType] of contentTypes.entries()) {
    const path = `${run.id}/compaction/private-${index}.json`;
    await mkdir(join(store.paths.artifactsDir, run.id, "compaction"), { recursive: true });
    await writeFile(join(store.paths.artifactsDir, path), '{"internal":"host-only"}');
    store.createArtifact({ id: `private-${index}`, runId: run.id, type: "json", path, contentType,
      sealedPayload: { internal: "host-only" }, createdAt: now });
  }
  store.createArtifact({ id: "public-output", runId: run.id, type: "markdown", path: "report.md", createdAt: now });
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner: { async runTask() { assert.fail("artifact lookup must not execute a runner"); } }, storeFactory: () => store,
  });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const url = `http://127.0.0.1:${daemon.server.address().port}`;
  return { store, url, query: `cwd=${encodeURIComponent(cwd)}`, run };
}

test("private Host recovery receipts do not clutter public Run artifact lists", async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/runs/${f.run.id}/artifacts?${f.query}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.artifacts.map(artifact => artifact.id), ["public-output"]);
  assert.equal(f.store.listArtifacts(f.run.id).length, 3, "public projection must preserve durable Host evidence");
  assert.equal((await fetch(`${f.url}/artifacts/public-output?${f.query}`)).status, 200);
});

for (const suffix of ["", "/content"]) {
  test(`private Host receipt ${suffix || "metadata"} is not a user artifact endpoint`, async t => {
    const f = await fixture(t);
    for (let index = 0; index < contentTypes.length; index++) {
      const response = await fetch(`${f.url}/artifacts/private-${index}${suffix}?${f.query}`);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "artifact_not_found");
    }
  });
}
