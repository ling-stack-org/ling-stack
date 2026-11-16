import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("mock relays close after startup and shutdown failures without hiding failed tests", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ling-mock-relay-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "failures.mjs");
  const helper = new URL("./support/mock-openai-compatible-server.mjs", import.meta.url).href;
  await writeFile(fixture, `
    import assert from "node:assert/strict";
    import test from "node:test";
    import { startMockOpenAICompatibleServer } from ${JSON.stringify(helper)};
    const urls = [];
    test("startup failure", async t => {
      urls.push((await startMockOpenAICompatibleServer(t)).url);
      throw new Error("runtime_already_running");
    });
    test("shutdown failure", async t => {
      urls.push((await startMockOpenAICompatibleServer(t)).url);
      try { assert.ok(true); }
      finally { throw new Error("harness_shutdown_incomplete_stores_retained"); }
    });
    test("all relays closed", async () => {
      assert.equal(urls.length, 2);
      for (const url of urls) await assert.rejects(fetch(url), error => error.cause?.code === "ECONNREFUSED");
    });
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // Run node:test in-process so the watchdog also owns any leaked HTTP listener.
  const result = spawnSync(process.execPath, ["--test-reporter=tap", fixture],
    { env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /runtime_already_running/u);
  assert.match(result.stdout, /harness_shutdown_incomplete_stores_retained/u);
  assert.match(result.stdout, /ok 3 - all relays closed/u);
  assert.match(result.stdout, /# pass 1\n# fail 2/u);
});
