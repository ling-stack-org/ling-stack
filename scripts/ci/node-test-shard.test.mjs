import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runNodeTestFiles } from "./node-test-shard.mjs";

async function fixture(t, sources) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-node-runner-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await Promise.all([mkdir(join(cwd, "test")), mkdir(join(cwd, "isolation"))]);
  await Promise.all(sources.map((source, index) => writeFile(join(cwd, `test/${index}.test.mjs`), source)));
  const reportPath = join(cwd, "reports", "tests-0.json");
  return { cwd, reportPath, files: sources.map((_, index) => `test/${index}.test.mjs`),
    options: { cwd, reportPath, stdio: "ignore", temporaryDirectory: join(cwd, "isolation"), terminationGraceMs: 100 } };
}

async function waitFor(check) {
  const deadline = AbortSignal.timeout(5000);
  for (;;) {
    const result = await check();
    if (result) return result;
    await delay(10, undefined, { signal: deadline });
  }
}

test("reports are durable while a file is running, and preserve stdout/stderr after completion", async t => {
  const f = await fixture(t, [`
    import { writeFile, access } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    import test from 'node:test';
    test('wait for release', { timeout: 10000 }, async () => {
      console.log('fixture stdout'); console.error('fixture stderr');
      await writeFile('ready', process.env.LING_STACK_HOME);
      for (;;) { try { await access('release'); break; } catch {} await setTimeout(10); }
    });
  `]);
  const run = runNodeTestFiles(f.files, f.options);
  await waitFor(async () => readFile(join(f.cwd, "ready"), "utf8").catch(() => false));
  const running = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(running.complete, false);
  assert.equal(running.results[0].status, "running");
  await writeFile(join(f.cwd, "release"), "done");
  assert.equal(await run, 0);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(report.complete, true);
  assert.equal(report.results[0].status, "passed");
  assert.ok(report.results[0].durationMs > 0);
  const log = await readFile(join(f.cwd, "reports/logs/tests-0/0.test.mjs.log"), "utf8");
  assert.match(log, /fixture stdout/u);
  assert.match(log, /fixture stderr/u);
  assert.deepEqual(await readdir(f.options.temporaryDirectory), []);
});

test("serial files never reuse a previous file's runtime home or workspace", async t => {
  const f = await fixture(t, [0, 1].map(index => `
    import { writeFileSync } from 'node:fs'; import test from 'node:test';
    test('home', () => writeFileSync('${index}.json', JSON.stringify({
      home: process.env.LING_STACK_HOME, workspace: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD })));
  `));
  assert.equal(await runNodeTestFiles(f.files, f.options), 0);
  const records = await Promise.all([0, 1].map(async index => JSON.parse(await readFile(join(f.cwd, `${index}.json`), "utf8"))));
  assert.notEqual(records[0].home, records[1].home);
  assert.notEqual(records[0].workspace, records[1].workspace);
});

test("file deadlines kill SIGTERM-resistant descendants, fail the file and continue", async t => {
  const f = await fixture(t, [
    `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import test from 'node:test';
     test('leaked child', () => {
       const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
       writeFileSync('child-pid', String(child.pid));
       setInterval(() => {}, 1000);
     });`,
    "import test from 'node:test'; test('next file still runs', () => {});",
  ]);
  assert.equal(await runNodeTestFiles(f.files, { ...f.options, fileTimeoutMs: 800 }), 1);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.results.map(result => result.status), ["timed_out", "passed"]);
  const pid = Number(await readFile(join(f.cwd, "child-pid"), "utf8"));
  await waitFor(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { assert.equal(error.code, "ESRCH"); return true; }
  });
  assert.deepEqual(await readdir(f.options.temporaryDirectory), []);
});

for (const timeout of [false, true]) test(`detached descendants cannot survive ${timeout ? "a file timeout" : "successful coordinator exit"}`, async t => {
  const f = await fixture(t, [
    `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import test from 'node:test';
     test('detached leak', () => {
       const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
         { detached: true, stdio: 'ignore' });
       writeFileSync('detached-pid', String(child.pid)); child.unref();
       ${timeout ? "setInterval(() => {}, 1000);" : ""}
     });`,
    "import test from 'node:test'; test('next file still runs', () => {});",
  ]);
  let pid;
  t.after(() => {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  });
  let code;
  try { code = await runNodeTestFiles(f.files, { ...f.options, fileTimeoutMs: 800 }); }
  finally { pid = Number(await readFile(join(f.cwd, "detached-pid"), "utf8").catch(() => 0)); }
  assert.equal(code, 1);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.deepEqual(report.results.map(result => result.status), [timeout ? "timed_out" : "leaked_processes", "passed"]);
  await waitFor(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { assert.equal(error.code, "ESRCH"); return true; }
  });
});

test("cancellation reaps a detached child with a cleared environment without touching unrelated processes", async t => {
  const f = await fixture(t, [
    `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
     const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"],
       { detached: true, stdio: 'ignore', env: {} });
     writeFileSync('detached-pid', String(child.pid)); child.unref(); setInterval(() => {}, 1000);`,
  ]);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const unrelatedClosed = new Promise(done => unrelated.once("close", done));
  t.after(async () => {
    unrelated.kill("SIGKILL");
    await unrelatedClosed;
  });
  const controller = new AbortController();
  const run = runNodeTestFiles(f.files, { ...f.options, signal: controller.signal });
  const pid = Number(await waitFor(() => readFile(join(f.cwd, "detached-pid"), "utf8").catch(() => false)));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  controller.abort("fixture cancelled");
  assert.equal(await run, 1);
  assert.equal(process.kill(unrelated.pid, 0), true);
  await waitFor(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { assert.equal(error.code, "ESRCH"); return true; }
  });
});

test("cancellation stops active files, does not launch queued files, and retains incomplete evidence", async t => {
  const f = await fixture(t, [
    "import { writeFileSync } from 'node:fs'; writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);",
    "throw new Error('cancelled queue must not launch');",
  ]);
  const controller = new AbortController();
  const run = runNodeTestFiles(f.files, { ...f.options, signal: controller.signal });
  await waitFor(async () => readFile(join(f.cwd, "ready"), "utf8").catch(() => false));
  controller.abort(new Error("fixture cancelled"));
  assert.equal(await run, 1);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(report.complete, false);
  assert.deepEqual(report.results.map(result => result.status), ["cancelled", "cancelled"]);
  assert.deepEqual(await readdir(f.options.temporaryDirectory), []);
});

test("the shard deadline bounds the entire queue independently of file deadlines", async t => {
  const f = await fixture(t, ["setInterval(() => {}, 1000);", "throw new Error('not reached');"]);
  assert.equal(await runNodeTestFiles(f.files, { ...f.options, fileTimeoutMs: 10000, shardTimeoutMs: 500 }), 1);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(report.complete, false);
  assert.deepEqual(report.results.map(result => result.status), ["cancelled", "cancelled"]);
});

test("an already cancelled shard cannot become green, including an empty assignment", async t => {
  const f = await fixture(t, ["throw new Error('not reached');"]);
  const signal = AbortSignal.abort("before launch");
  for (const files of [[], f.files]) assert.equal(await runNodeTestFiles(files, { ...f.options, signal }), 1);
  assert.deepEqual(await readdir(f.options.temporaryDirectory), []);
});

test("log creation failures still remove the private isolation directory", async t => {
  const f = await fixture(t, ["import 'node:test';"]);
  await mkdir(join(f.cwd, "reports/logs/tests-0/0.test.mjs.log"), { recursive: true });
  await assert.rejects(runNodeTestFiles(f.files, f.options), { code: "EISDIR" });
  assert.deepEqual(await readdir(f.options.temporaryDirectory), []);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  assert.equal(report.results[0].status, "error");
});
