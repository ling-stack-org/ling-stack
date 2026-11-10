import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSupervisorSpawn, readSupervisorArtifact } from "../dist/features/execution-engines/windows-supervisor.js";

// Run on Windows after build:engine-supervisor. These tests never launch an agent/account.
const native = { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 15000 };
const helperPath = fileURLToPath(new URL("../dist/native/engine-supervisor/ling-engine-supervisor.exe", import.meta.url));

async function fixture(t, mode, hashOverride) {
  const root = await mkdtemp(join(tmpdir(), "ling windows supervisor "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "owned-child.json");
  const artifact = await readSupervisorArtifact(helperPath);
  const digest = hashOverride ?? createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const launch = createSupervisorSpawn(artifact, process.execPath, digest);
  const code = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({root:process.pid, descendant:child.pid}));
    child.unref();
    ${mode === "exit" ? "process.stdout.write('native-output');" : "setInterval(() => {}, 1000);"}
  `;
  const child = launch(process.execPath, ["-e", code], { cwd: root,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: root, TEMP: root, TMP: root },
    stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  const errors = [];
  let stdout = "";
  child.on("error", error => errors.push(error.message));
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", (code) => resolve(code)));
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await closed; });
  return { child, closed, errors, marker, get stdout() { return stdout; } };
}

async function marker(path) {
  for (let i = 0; i < 500; i++) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("owned fixture did not start");
}

async function gone(pid) {
  for (let i = 0; i < 500; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(10);
  }
  assert.fail(`owned fixture process ${pid} survived cleanup`);
}

test("Windows native root exit reaps descendants retaining stdout and forwards native output unchanged", native, async t => {
  const f = await fixture(t, "exit");
  assert.equal(await f.closed, 0);
  const pids = await marker(f.marker);
  await gone(pids.root); await gone(pids.descendant);
  assert.equal(f.stdout, "native-output");
  assert.deepEqual(f.errors, []);
});

for (const reason of ["cancel", "owner-eof", "unexpected-control"]) {
  test(`Windows ${reason} reaps the native root and descendants`, native, async t => {
    const f = await fixture(t, "wait");
    const pids = await marker(f.marker);
    if (reason === "cancel") f.child.kill("SIGKILL");
    else if (reason === "owner-eof") f.child.stdio[3].end();
    else f.child.stdio[3].write("unexpected");
    await f.closed;
    await gone(pids.root); await gone(pids.descendant);
  });
}

test("Windows digest mismatch refuses to execute", native, async t => {
  const f = await fixture(t, "exit", "0".repeat(64));
  assert.equal(await f.closed, 125);
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  assert.equal(f.stdout, "");
});

test("Windows abrupt Daemon-owner death closes fd3 and kills the owned generation", native, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling supervisor owner "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, "runtime.pid");
  const moduleUrl = new URL("../dist/features/execution-engines/windows-supervisor.js", import.meta.url).href;
  const code = `
    import { createSupervisorSpawn, readSupervisorArtifact } from ${JSON.stringify(moduleUrl)};
    import { readFile } from 'node:fs/promises'; import { createHash } from 'node:crypto';
    const artifact = await readSupervisorArtifact(${JSON.stringify(helperPath)});
    const digest = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
    const child = createSupervisorSpawn(artifact, process.execPath, digest)(process.execPath,
      ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({root:process.pid})); setInterval(() => {}, 1000);`)}],
      {cwd:${JSON.stringify(root)}, env:{SystemRoot:process.env.SystemRoot}, stdio:['pipe','pipe','pipe'],shell:false});
    child.on('error', () => {}); child.stdout.resume(); child.stderr.resume();
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => owner.once("close", resolve));
  t.after(async () => { owner.kill("SIGKILL"); await closed; });
  const pids = await marker(markerPath);
  owner.kill("SIGKILL");
  await closed;
  await gone(pids.root);
});
