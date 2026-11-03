import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  assignTestShards,
  createDaemonShardIsolation,
  discoverDaemonTestFiles,
  estimateTestWeight,
  runDaemonTestFiles,
} from "./daemon-test-shard.mjs";

test("daemon shard discovery leaves the dedicated dependency check out", async () => {
  const files = await discoverDaemonTestFiles();
  assert.ok(files.length > 0);
  assert.ok(!files.includes("test/dependency-security.test.mjs"));
});

async function runnerFixture(t, sources, names = sources.map((_, index) => `${index}.test.mjs`)) {
  const root = await mkdtemp(join(tmpdir(), "ling-daemon-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([mkdir(join(root, "test")), mkdir(join(root, "isolation"))]);
  await Promise.all(sources.map((source, index) => writeFile(join(root, "test", names[index]), source)));
  return { root, files: names.map(name => `test/${name}`),
    options: { cwd: root, temporaryDirectory: join(root, "isolation"), stdio: "ignore" } };
}

test("bounded runner fails a leaked file and still completes its next file", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await runnerFixture(t, [
    "import test from 'node:test'; test('passes but leaks a handle', () => { setInterval(() => {}, 1000); });",
    "import { writeFileSync } from 'node:fs'; import test from 'node:test'; test('next file', () => writeFileSync('next-ran', 'yes'));",
  ]);
  const runner = pathToFileURL(resolve("scripts/ci/daemon-test-shard.mjs")).href;
  const source = `import { runDaemonTestFiles } from ${JSON.stringify(runner)};
    process.exitCode = await runDaemonTestFiles(${JSON.stringify(fixture.files)},
      ${JSON.stringify({ ...fixture.options, fileTimeoutMs: 800, terminationGraceMs: 100 })});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_TEST_CONTEXT: "" },
  });
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }, 5000);
  const status = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("close", resolveStatus);
  }).finally(() => clearTimeout(watchdog));
  assert.equal(watchdogExpired, false, "file deadline must finish before the outer safety watchdog");
  assert.equal(status, 1, "a leaked handle must fail, never force a green result");
  assert.equal(await readFile(join(fixture.root, "next-ran"), "utf8"), "yes");
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("daemon workers overlap while retaining separate homes and workspaces", async (t) => {
  const fixture = await runnerFixture(t, [0, 1].map(index => `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    import test from 'node:test';
    test('worker rendezvous', { timeout: 10000 }, async context => {
      await writeFile('${index}.json', JSON.stringify({ home: process.env.LING_STACK_HOME,
        workspace: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD }));
      for (;;) {
        try { await readFile('${1 - index}.json'); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await setTimeout(10, undefined, { signal: context.signal });
      }
      assert.ok(process.env.LING_STACK_HOME);
    });
  `));
  assert.equal(await runDaemonTestFiles(fixture.files, { ...fixture.options, concurrency: 2 }), 0);
  const records = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(fixture.root, `${index}.json`), "utf8"))));
  assert.notEqual(records[0].home, records[1].home);
  assert.notEqual(records[0].workspace, records[1].workspace);
  for (const record of records) {
    assert.notEqual(record.home, record.workspace);
    await assert.rejects(stat(record.home), { code: "ENOENT" });
    await assert.rejects(stat(record.workspace), { code: "ENOENT" });
  }
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("file-specific watchdogs can extend only a known slow fixture", async (t) => {
  const fixture = await runnerFixture(t, [`
    import { setTimeout as delay } from 'node:timers/promises';
    import test from 'node:test';
    test('slow fixture', async () => { await delay(1200); });
  `], ["recovery-discovery-fair-scan.test.mjs"]);
  const report = join(fixture.root, "report.json");
  assert.equal(await runDaemonTestFiles(fixture.files, {
    ...fixture.options,
    fileTimeoutMs: 1000,
    fileTimeouts: { "test/recovery-discovery-fair-scan.test.mjs": 2500 },
    reportPath: report,
  }), 0);
  const result = JSON.parse(await readFile(report, "utf8")).results[0];
  assert.equal(result.fileTimeoutMs, 2500);
  assert.equal(result.status, "passed");
});

test("daemon workers report failures and finish every assigned file before cleanup", async (t) => {
  const fixture = await runnerFixture(t, [0, 1, 2].map(index => `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import test from 'node:test';
    test('record execution', async () => {
      await writeFile('${index}.json', 'executed');
      assert.equal(${index}, 0);
    });
  `));
  assert.equal(await runDaemonTestFiles(fixture.files, { ...fixture.options, concurrency: 2 }), 1);
  for (const index of [0, 1, 2]) assert.equal(await readFile(join(fixture.root, `${index}.json`), "utf8"), "executed");
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("daemon workers reject invalid concurrency and clean up launch errors", async (t) => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(runDaemonTestFiles([], { concurrency }), /positive integer/u);
  }
  const fixture = await runnerFixture(t, ["import 'node:test';"]);
  await assert.rejects(runDaemonTestFiles(fixture.files, { ...fixture.options, cwd: join(fixture.root, "missing") }), { code: "ENOENT" });
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
  assert.equal(await runDaemonTestFiles([], { concurrency: 2 }), 0);
});

test("daemon workers never launch an empty bucket or rediscover unselected tests", async (t) => {
  const fixture = await runnerFixture(t, ["import test from 'node:test'; test('selected', () => {});",
    "throw new Error('unselected test must not execute');"]);
  assert.equal(await runDaemonTestFiles([fixture.files[0], fixture.files[0]], {
    ...fixture.options, concurrency: 4,
  }), 0);
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("native lifecycle fixtures finish exclusively before parallel workers start", async (t) => {
  const fixture = await runnerFixture(t, [
    ...[0, 1].map(index => `
      import assert from 'node:assert/strict';
      import { existsSync, writeFileSync } from 'node:fs';
      import test from 'node:test';
      test('exclusive fixture', () => {
        assert.equal(existsSync('parallel-started'), false);
        ${index === 1 ? "assert.ok(existsSync('exclusive-0'));" : ""}
        writeFileSync('exclusive-${index}', 'done');
      });
    `),
    `import assert from 'node:assert/strict';
     import { existsSync, writeFileSync } from 'node:fs';
     import test from 'node:test';
     test('parallel fixture', () => {
       for (const index of [0, 1]) assert.ok(existsSync('exclusive-' + index));
       writeFileSync('parallel-started', 'done');
     });`,
  ], ['acp-kimi-host-read.test.mjs', 'acp-kimi-host-terminal.test.mjs', 'ordinary.test.mjs']);
  assert.equal(await runDaemonTestFiles([...fixture.files].reverse(), { ...fixture.options, concurrency: 2 }), 0);
  assert.equal(await readFile(join(fixture.root, "parallel-started"), "utf8"), "done");
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("delegation lifecycle fixture finishes exclusively before ordinary files", async (t) => {
  const fixture = await runnerFixture(t, [
    `import assert from 'node:assert/strict';
     import { existsSync, writeFileSync } from 'node:fs';
     import test from 'node:test';
     test('delegation lifecycle', () => {
       assert.equal(existsSync('ordinary-started'), false);
       writeFileSync('delegation-finished', 'done');
     });`,
    `import assert from 'node:assert/strict';
     import { existsSync, writeFileSync } from 'node:fs';
     import test from 'node:test';
     test('ordinary file', () => {
       writeFileSync('ordinary-started', 'yes');
       assert.ok(existsSync('delegation-finished'));
     });`,
  ], ['delegation-production-tool-surface.test.mjs', 'aaa-ordinary.test.mjs']);
  assert.equal(await runDaemonTestFiles([...fixture.files].reverse(), { ...fixture.options, concurrency: 1 }), 0);
  assert.equal(await readFile(join(fixture.root, 'delegation-finished'), 'utf8'), 'done');
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("an exclusive fixture failure still runs other files and fails the shard", async (t) => {
  const fixture = await runnerFixture(t, [
    "import test from 'node:test'; test('exclusive failure', () => { throw new Error('expected'); });",
    "import { writeFileSync } from 'node:fs'; import test from 'node:test'; test('other file', () => writeFileSync('executed', 'done'));",
  ], ['acp-kimi-host-read.test.mjs', 'ordinary.test.mjs']);
  assert.equal(await runDaemonTestFiles(fixture.files, { ...fixture.options, concurrency: 2 }), 1);
  assert.equal(await readFile(join(fixture.root, "executed"), "utf8"), "done");
  assert.deepEqual(await readdir(fixture.options.temporaryDirectory), []);
});

test("daemon shard assignment is deterministic and covers every test once", () => {
  const files = [
    "test/runtime-supervisor.test.mjs",
    "test/contracts.test.mjs",
    "test/channel-reply-dispatch.test.mjs",
    "test/providers-api.test.mjs",
    "test/remote-gateway-security.test.mjs",
  ];
  const first = assignTestShards(files, 3);
  const second = assignTestShards([...files].reverse(), 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.flatMap((bucket) => bucket.files).sort(), files.sort());
  assert.equal(new Set(first.flatMap((bucket) => bucket.files)).size, files.length);
  assert.ok(first.every((bucket) => bucket.weight > 0));
});

test("weighted assignment puts expensive tests into the lightest shard", () => {
  assert.ok(estimateTestWeight("test/contracts.test.mjs") >= 1);
  assert.ok(estimateTestWeight("test/channel-workflow-status.test.mjs") >= 3);
  assert.throws(() => assignTestShards([], 0), /positive integer/);
});

test("daemon shard isolation provides distinct absolute home and workspace directories", async (t) => {
  const isolation = await createDaemonShardIsolation("contract");
  t.after(async () => {
    await rm(isolation.root, { recursive: true, force: true });
  });

  for (const path of [isolation.home, isolation.workspace]) {
    assert.equal(isAbsolute(path), true);
    assert.equal(resolve(path), path);
    assert.equal((await stat(path)).isDirectory(), true);
  }
  assert.notEqual(isolation.home, isolation.workspace);
  assert.ok(isolation.root.startsWith(`${resolve(tmpdir())}/`));
});
