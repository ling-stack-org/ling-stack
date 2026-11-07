import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOwnedExecutionDiagnostic } from "./support/codex-owned-execution-diagnostic.ts";

function context() {
  const abort = new AbortController();
  const hooks: (() => unknown)[] = [];
  const records: string[] = [];
  const t = { signal: abort.signal, after: (fn: () => unknown) => { hooks.push(fn); },
    diagnostic: (value: string) => { records.push(value); } } as unknown as TestContext;
  return { t, abort, hooks, records };
}

test("owned execution diagnostics stay silent on success and detach before normal test abort", async () => {
  const f = context();
  const child = new EventEmitter() as ChildProcess;
  assert.equal(await captureOwnedExecutionDiagnostic(f.t, 8000, async diagnostic => {
    diagnostic.begin("fixture_setup");
    diagnostic.observeChild(child);
    f.t.after(() => { diagnostic.begin("fixture_cleanup"); diagnostic.end(); });
    return 42;
  }), 42);
  for (const hook of f.hooks) await hook();
  f.abort.abort();
  assert.deepEqual(f.records, []);
  assert.deepEqual(child.eventNames(), []);
  assert.deepEqual(getEventListeners(f.t.signal, "abort"), []);
});

test("body failures preserve the original error and bounded phase evidence without payloads", async () => {
  const f = context();
  const child = new EventEmitter() as ChildProcess;
  const secret = "private-owned-diagnostic-sentinel";
  const original = new Error(secret);
  await assert.rejects(captureOwnedExecutionDiagnostic(f.t, 8000, async diagnostic => {
    diagnostic.begin("sqlite_init");
    diagnostic.begin("spawn_call");
    diagnostic.observeChild(child);
    child.emit("spawn");
    child.emit("message", { method: "initialize", params: { secret } });
    child.emit("message", { method: secret });
    child.emit("message", { method: "thread/start" });
    child.emit("message", { method: "turn/start" });
    diagnostic.begin("native_reap");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    diagnostic.begin("assertions");
    throw original;
  }), error => error === original);
  f.abort.abort();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].includes(secret), false);
  const record = JSON.parse(f.records[0]);
  assert.equal(record.reason, "body_failure");
  assert.equal(record.timeoutMs, 8000);
  assert.equal(record.activePhase, "assertions");
  assert.deepEqual(record.phases.map((phase: { phase: string }) => phase.phase), ["sqlite_init", "spawn_call", "native_reap", "assertions"]);
  for (const phase of record.phases) {
    assert.ok(phase.durationMs >= 0);
    assert.ok(phase.cpuMs.user >= 0 && phase.cpuMs.system >= 0);
  }
  assert.deepEqual(Object.keys(record.marks), ["child_spawn", "initialize_request", "thread_start_request", "turn_start_request", "child_exit", "child_close"]);
  assert.deepEqual(child.eventNames(), []);
  assert.deepEqual(getEventListeners(f.t.signal, "abort"), []);
});

async function runProbe(mode: "success" | "timeout" | "sync-stall" | "cleanup-failure") {
  const helper = new URL("./support/codex-owned-execution-diagnostic.ts", import.meta.url).href;
  const source = `import { test } from 'node:test';
    import { setImmediate } from 'node:timers/promises';
    import { captureOwnedExecutionDiagnostic } from ${JSON.stringify(helper)};
    test('phase probe', { timeout: 40 }, t => captureOwnedExecutionDiagnostic(t, 40, async d => {
      const keepAlive = setInterval(() => {}, 1000);
      t.after(() => {
        d.begin('fixture_cleanup');
        try { clearInterval(keepAlive); ${mode === "cleanup-failure" ? "throw new Error('cleanup sentinel');" : ""} d.end(); }
        catch (error) { d.fail('cleanup_failure'); throw error; }
      });
      d.begin('sqlite_init');
      ${mode === "sync-stall" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); d.begin('fixture_node_read'); await setImmediate();" : ""}
      ${mode === "timeout" || mode === "sync-stall" ? "await new Promise(() => {});" : "d.end();"}
    }));`;
  const directory = await mkdtemp(join(tmpdir(), "ling-owned-diagnostic-"));
  const file = join(directory, "probe.test.mjs");
  await writeFile(file, source);
  const environment = { ...process.env, NODE_OPTIONS: "" };
  delete environment.NODE_TEST_CONTEXT;
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file],
      { stdio: ["ignore", "pipe", "pipe"], env: environment });
    let output = "";
    const limit = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(limit);
      void rm(directory, { recursive: true, force: true }).then(() => resolve({ code, output }), reject);
    });
  });
}

test("real runner success stays silent through cleanup and normal signal abortion", async () => {
  const result = await runProbe("success");
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.includes("codex_owned_execution_diagnostic_v1"), false);
});

for (const mode of ["timeout", "sync-stall", "cleanup-failure"] as const) {
  test(`real runner ${mode} emits one failure diagnostic even when the body never settles`, async () => {
    const result = await runProbe(mode);
    assert.equal(result.code, 1, result.output);
    const records = result.output.split("\n").filter(line => line.startsWith('# {"kind":"codex_owned_execution_diagnostic_v1"'));
    assert.equal(records.length, 1, result.output);
    const record = JSON.parse(records[0].slice(2));
    assert.equal(record.reason, mode === "cleanup-failure" ? "cleanup_failure" : "test_aborted");
    assert.equal(record.timeoutMs, 40);
    assert.equal(record.activePhase, mode === "timeout" ? "sqlite_init" : mode === "sync-stall" ? "fixture_node_read" : "fixture_cleanup");
    if (mode === "sync-stall") assert.ok(record.phases.find((phase: { phase: string }) => phase.phase === "sqlite_init").durationMs >= 80);
    if (mode !== "cleanup-failure") assert.match(result.output, /testTimeoutFailure/);
    else assert.match(result.output, /cleanup sentinel/);
  });
}
