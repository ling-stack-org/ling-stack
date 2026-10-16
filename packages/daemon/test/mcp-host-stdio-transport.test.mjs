import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createSqliteRunStore } from "@ling-stack/core";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

// Only selects an actual isolated compilation. It neither transforms source nor fabricates authority.
const dist = process.env.LING_MCP_STDIO_TEST_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const load = path => import(pathToFileURL(join(dist, path)).href);
const { createHostMcpStdioTransport } = await load("features/mcp/host-stdio-transport.js");
const { reserveHostMcpOperation } = await load("features/mcp/host-operation.js");
const { AttemptHostOperationTracker } = await load("runtime/attempt-host-operation-tracker.js");
const MIB = 1024 * 1024;
const LARGE_STDIO_BOUNDARY_TIMEOUT_MS = 45_000;
const required = { kind: "user_input_required", requestId: "stdio-pause", requestVersion: 1 };

const serverScript = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.WIRE_LOG, 'spawn\\n');
const notify = (method, params = {}) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\\n');
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(process.env.WIRE_LOG, request.method+'\\n');
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'actual-stdio',version:'1'}}})+'\\n');
  else if (request.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'actual stdio result'}],...(process.env.IS_ERROR ? {isError:true}: {})}})+'\\n');
  else if (request.method === 'fixture/send') notify('fixture/received',{length:request.params.payload.length});
});
setTimeout(()=>process.exit(0),7000).unref();
`;

async function fixture(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-mcp-owned-stdio-")));
  let transport, operation, finished = false;
  // Close original local handles before fixture Store.close, including assertion-failure paths.
  t.after(async () => { if (transport) await transport.close(); if (operation && !finished) operation.finish(); });
  const f = createUnifiedExecFixture(t, cwd, { id: "stdio-task", title: "stdio", prompt: "isolated" }, "stdio-run");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  operation = reserveHostMcpOperation(tracker, "stdio-call");
  const wireLog = join(cwd, "actual-wire");
  transport = createHostMcpStdioTransport({
    launch: { command: options.command ?? process.execPath, args: ["-e", options.script ?? serverScript],
      env: { WIRE_LOG: wireLog, ...(options.env ?? {}) }, cwd },
    operation, signal: options.signal, sendTimeoutMs: options.sendTimeoutMs ?? 5000,
  });
  const events = new EventEmitter(), errors = [], messages = [];
  let closes = 0;
  transport.onmessage = message => { messages.push(message); events.emit("message", message); };
  transport.onerror = error => { errors.push(error); };
  transport.onclose = () => { closes++; };
  const rows = () => tracker.executorGroup.getSnapshot().operations.map(row => f.store.getHostOperation(row.ticket.id));
  const wire = () => existsSync(wireLog) ? readFileSync(wireLog, "utf8").trim().split("\n") : [];
  return { ...f, cwd, source, tracker, operation, transport, wire, rows, errors, messages, events,
    get closes() { return closes; },
    finish() { finished = true; operation.finish(); },
  };
}

async function until(predicate, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < end, "Timed out waiting for actual stdio boundary");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const frame = size => ({ jsonrpc: "2.0", method: "fixture/send", params: { payload: "x".repeat(size) } });
function replaceOwner(f) {
  f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "stdio-successor", runnerId: "pi", status: "started", now: new Date().toISOString() });
}
function assertUnknown(f) {
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "unknown_outcome" && row.settlementKind !== "known_no_start"));
}

for (const isError of [false, true]) {
  test(`public SDK Client uses real owned stdio (${isError ? "isError" : "success"}) without minting remote safety`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { env: isError ? { IS_ERROR: "1" } : {} });
    const client = new Client({ name: "fixture", version: "1" });
    try {
      await client.connect(f.transport, { timeout: 3000 });
      let pending;
      f.operation.launchToolDispatch(() => { pending = client.callTool({ name: "fixture", arguments: {} }, undefined, { timeout: 3000 }); });
      const result = await pending;
      assert.equal(result.content[0].text, "actual stdio result");
      assert.equal(Boolean(result.isError), isError);
    } finally { await client.close(); }
    assert.equal(f.wire().filter(value => value === "spawn").length, 1);
    assert.equal(f.wire().filter(value => value === "tools/call").length, 1);
    assert.deepEqual(f.transport.getCloseObservation(), { leaderExited: true, stdioClosed: true, descendants: "unverified", settledBy: "close", cleanupFailures: [] });
    f.finish(); assertUnknown(f);
    const reopened = createSqliteRunStore(f.cwd);
    try { assert.equal(reopened.listHostOperationBlockers(f.source).length, 2); }
    finally { reopened.close(); }
  });
}

test("structural or cloned operation cannot construct a native launcher", async t => {
  const f = await fixture(t);
  assert.throws(() => createHostMcpStdioTransport({ launch: { command: process.execPath, args: [], env: {} },
    operation: { ...f.operation } }), /mcp_host_operation_invalid/);
  assert.deepEqual(f.wire(), []);
});

for (const beforeStart of ["required", "abort"]) {
  test(`${beforeStart} before start produces zero actual spawn and exact no-start`, async t => {
    const f = await fixture(t, beforeStart === "abort" ? { signal: AbortSignal.abort() } : {});
    if (beforeStart === "required") f.tracker.executorGroup.closeAdmission(required);
    await assert.rejects(f.transport.start());
    await f.transport.close(); f.finish();
    assert.deepEqual(f.wire(), []);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
    assert.equal(f.transport.getCloseObservation().settledBy, "not_started");
  });
}

for (const timing of ["rollback", "post_commit"]) {
  test(`actual spawn survives ${timing} exception with original handle and unknown`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const original = f.store.launchHostOperation.bind(f.store);
    const originalExec = f.store.database.exec;
    const fault = new Error(`stdio_${timing}_fault`);
    let injected = false;
    f.store.launchHostOperation = (ticket, effect) => {
      if (injected) return original(ticket, effect);
      injected = true;
      if (timing === "rollback") f.store.database.exec = function(sql) {
        if (/^COMMIT;?$/u.test(sql.trim())) throw fault;
        return originalExec.call(this, sql);
      };
      try { const result = original(ticket, effect); if (timing === "post_commit") throw fault; return result; }
      finally { f.store.database.exec = originalExec; }
    };
    try { await assert.rejects(f.transport.start(), error => error === fault); }
    finally { f.store.launchHostOperation = original; }
    await f.transport.close();
    assert.equal(f.wire().filter(value => value === "spawn").length, 1);
    assert.equal(f.transport.getCloseObservation().stdioClosed, true);
    assert.equal(f.transport.getCloseObservation().leaderExited, true);
    f.finish(); assertUnknown(f);
    await assert.rejects(f.transport.start(), /already_started/);
  });
}

test("spawn ENOENT is entered unknown and returns a sanitized error", { timeout: 6000 }, async t => {
  const f = await fixture(t, { command: "/missing/secret-stdio-executable" });
  await assert.rejects(f.transport.start(), error => !error.message.includes("secret-stdio-executable"));
  await f.transport.close(); f.finish(); assertUnknown(f);
  assert.equal(f.closes, 1);
});

test("parent post-COMMIT failure seals queued SDK tools/call before actual native write", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const client = new Client({ name: "parent-fault", version: "1" });
  await client.connect(f.transport, { timeout: 3000 });
  const launch = f.store.launchHostOperation.bind(f.store);
  const fault = new Error("parent_commit_after_pending");
  f.store.launchHostOperation = (ticket, effect) => {
    const parent = !f.store.getHostOperation(ticket.operationId).parentOperationId;
    const result = launch(ticket, effect);
    if (parent) throw fault;
    return result;
  };
  let pending;
  try {
    assert.throws(() => f.operation.launchToolDispatch(() => {
      pending = client.callTool({ name: "fixture", arguments: {} }, undefined, { timeout: 3000 });
      void pending.catch(() => {});
    }), error => error === fault);
  } finally { f.store.launchHostOperation = launch; await client.close(); }
  await assert.rejects(pending);
  assert.equal(f.wire().filter(value => value === "tools/call").length, 0);
  f.finish(); assertUnknown(f);
});

for (const timing of ["rollback", "post_commit"]) {
  test(`actual stdin write ${timing} fault retains one accepted frame and never retries`, { timeout: 10_000 }, async t => {
    const f = await fixture(t); await f.transport.start();
    const original = f.store.continueHostOperationEffect.bind(f.store);
    const originalExec = f.store.database.exec;
    const fault = new Error(`stdio_write_${timing}`);
    let injected = false;
    f.store.continueHostOperationEffect = (ticket, effect, mode) => {
      if (injected || mode === "cleanup") return original(ticket, effect, mode);
      injected = true;
      if (timing === "rollback") f.store.database.exec = function(sql) {
        if (/^COMMIT;?$/u.test(sql.trim())) throw fault;
        return originalExec.call(this, sql);
      };
      try { const result = original(ticket, effect, mode); if (timing === "post_commit") throw fault; return result; }
      finally { f.store.database.exec = originalExec; }
    };
    try { await assert.rejects(f.transport.send(frame(4)), error => error === fault); }
    finally { f.store.continueHostOperationEffect = original; }
    await f.transport.close();
    assert.equal(f.wire().filter(value => value === "fixture/send").length, 1);
    assert.equal(f.messages.length, 0, "a late response cannot revive a failed write transaction");
    f.finish(); assertUnknown(f);
  });
}

for (const replace of [false, true]) {
  test(`${replace ? "owner replacement" : "required closure"} after real spawn blocks later write`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    await f.transport.start(); await until(() => f.wire().includes("spawn"));
    if (replace) replaceOwner(f); else f.tracker.executorGroup.closeAdmission(required);
    await assert.rejects(f.transport.send(frame(10)));
    await f.transport.close();
    assert.equal(f.wire().filter(value => value === "fixture/send").length, 0);
    if (replace) assert.ok(f.transport.getCloseObservation().cleanupFailures.length > 0);
    else assert.equal(f.transport.getCloseObservation().stdioClosed, true);
    f.finish(); assertUnknown(f);
  });
}

test("backpressure resolves only after one actual large frame drains and write callback completes", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `
    const readline = require('node:readline');
    setTimeout(()=>{ const lines=readline.createInterface({input:process.stdin});
      lines.on('line', line=>{const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/received',params:{length:request.params.payload.length}})+'\\n');});
    },250);
    setTimeout(()=>process.exit(0),7000).unref();
  ` });
  await f.transport.start();
  let sent = false;
  const pending = f.transport.send(frame(8 * MIB)).then(() => { sent = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sent, false, "a real full stdin buffer must not settle at write admission");
  await pending;
  await until(() => f.messages.length === 1);
  assert.equal(f.messages[0].params.length, 8 * MIB);
  await f.transport.close(); f.finish(); assertUnknown(f);
});

for (const cause of ["close", "deadline", "abort"]) {
  test(`pending actual stdin write settles on ${cause}, not only drain`, { timeout: 10_000 }, async t => {
    const controller = new AbortController();
    const f = await fixture(t, { signal: controller.signal, sendTimeoutMs: cause === "deadline" ? 50 : 5000,
      script: `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),4000);` });
    await f.transport.start();
    const rejected = assert.rejects(f.transport.send(frame(8 * MIB)));
    if (cause === "close") await f.transport.close();
    else if (cause === "abort") controller.abort();
    await rejected; await f.transport.close();
    assert.equal(f.closes, 1);
    assert.equal(f.transport.getCloseObservation().descendants, "unverified");
    f.finish(); assertUnknown(f);
  });
}

test("real EPIPE/write callback error rejects pending send without leaking native command secrets", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `require('node:fs').closeSync(0);process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n');setTimeout(()=>{},2500);` });
  await f.transport.start(); await until(() => f.messages.length === 1);
  await assert.rejects(f.transport.send(frame(8 * MIB)), /(?:write_failed|pipe_error):EPIPE/);
  await f.transport.close();
  assert.ok(f.errors.every(error => !error.message.includes("process.stdin.destroy")));
  f.finish(); assertUnknown(f);
});

test("close is shared and waits for actual close after ignored EOF/TERM; kill acceptance is not safety", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `process.stdin.resume();process.stdin.on('end',()=>{});process.on('SIGTERM',()=>{});process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),5000);` });
  await f.transport.start(); await until(() => f.messages.length === 1);
  const first = f.transport.close(), second = f.transport.close();
  assert.equal(first, second);
  await first;
  assert.equal(f.closes, 1);
  assert.equal(f.transport.getCloseObservation().settledBy, "close");
  assert.equal(f.transport.getCloseObservation().leaderExited, true);
  assert.equal(f.transport.getCloseObservation().descendants, "unverified");
  f.finish(); assertUnknown(f);
});

test("owner replacement between TERM and KILL prevents escalation and retains unknown", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `
    const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{});
    process.on('SIGTERM',()=>fs.appendFileSync(process.env.WIRE_LOG,'term\\n'));
    process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n');
    setInterval(()=>{},1000);setTimeout(()=>process.exit(0),3500);
  ` });
  await f.transport.start(); await until(() => f.messages.length === 1);
  const close = f.transport.close();
  await until(() => f.wire().includes("term")); replaceOwner(f);
  await close;
  const observation = f.transport.getCloseObservation();
  assert.equal(observation.settledBy, "cleanup_deadline");
  assert.equal(observation.leaderExited, false, "old leader survives rejected KILL; no fabricated close");
  assert.equal(observation.stdioClosed, false);
  assert.ok(observation.cleanupFailures.some(value => value.startsWith("sigkill:")));
  f.finish(); assertUnknown(f);
});

test("escaped descendant retaining stdout causes bounded local deadline, not process-tree safe", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `
    require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:['ignore',1,2],detached:true}).unref();
    process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n',()=>process.exit(0));
  ` });
  await f.transport.start(); await until(() => f.messages.length === 1);
  await f.transport.close();
  assert.equal(f.transport.getCloseObservation().settledBy, "cleanup_deadline");
  assert.equal(f.transport.getCloseObservation().leaderExited, true);
  assert.equal(f.transport.getCloseObservation().stdioClosed, false);
  f.finish(); assertUnknown(f);
});

test("owned stdout handles actual UTF-8 split, CRLF, multiple frames, and >SDK-default payload", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { script: `
    const small=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'fixture/chinese',params:{text:'中文'}})+'\\r\\n');
    const split=small.indexOf(Buffer.from('中'))+1;process.stdout.write(small.subarray(0,split));
    setTimeout(()=>{process.stdout.write(small.subarray(split));process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/large',params:{text:'x'.repeat(11*1024*1024)}})+'\\n');},20);
    process.stdin.resume();
  ` });
  await f.transport.start(); await until(() => f.messages.length === 2, 10_000);
  assert.equal(f.messages[0].params.text, "中文");
  assert.equal(f.messages[1].params.text.length, 11 * MIB);
  await f.transport.close(); f.finish(); assertUnknown(f);
});

for (const overflow of [false, true]) {
  test(`actual stdout ${overflow ? "exceeds" : "meets"} 64 MiB framing limit`, { timeout: 50_000 }, async t => {
    const f = await fixture(t, { script: `
      const message={jsonrpc:'2.0',method:'fixture/max',params:{payload:''}};
      const overhead=Buffer.byteLength(JSON.stringify(message)+'\\n');
      message.params.payload='x'.repeat(64*1024*1024-overhead+${overflow ? "1" : "0"});
      process.stdout.write(JSON.stringify(message)+'\\n');process.stdin.resume();
    ` });
    await f.transport.start();
    if (overflow) {
      await until(() => f.errors.length > 0, LARGE_STDIO_BOUNDARY_TIMEOUT_MS);
      assert.equal(f.messages.length, 0);
    } else {
      await until(() => f.messages.length === 1, LARGE_STDIO_BOUNDARY_TIMEOUT_MS);
      assert.equal(f.errors.length, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(f.messages[0]) + "\n"), 64 * MIB);
      f.messages.length = 0;
    }
    await f.transport.close(); f.finish(); assertUnknown(f);
  });
}

test("outbound bytes and pending waiter budgets reject excess frames without additional native writes", { timeout: 15_000 }, async t => {
  const warnings = [];
  const onWarning = warning => { warnings.push(warning); };
  process.on("warning", onWarning); t.after(() => process.removeListener("warning", onWarning));
  const f = await fixture(t); await f.transport.start();
  await assert.rejects(f.transport.send(frame(64 * MIB)), /send_budget_exceeded/);
  const pending = Array.from({ length: 64 }, () => f.transport.send(frame(1)));
  await assert.rejects(f.transport.send(frame(1)), /send_budget_exceeded/);
  await Promise.all(pending);
  await until(() => f.wire().filter(value => value === "fixture/send").length === 64);
  assert.equal(f.wire().filter(value => value === "fixture/send").length, 64);
  await f.transport.close(); f.finish(); assertUnknown(f);
  assert.ok(!warnings.some(warning => warning.name === "MaxListenersExceededWarning"), "bounded concurrent sends must use shared native observers");
});

test("required closure within one multi-frame chunk suppresses the later message and SDK callback", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `
    process.stdout.write('{"jsonrpc":"2.0","method":"fixture/first"}\\n{"jsonrpc":"2.0","method":"fixture/late"}\\n');
    process.stdin.resume();
  ` });
  f.transport.onmessage = message => { f.messages.push(message); f.tracker.executorGroup.closeAdmission(required); };
  await f.transport.start(); await until(() => f.closes === 1);
  assert.deepEqual(f.messages.map(message => message.method), ["fixture/first"]);
  await assert.rejects(f.transport.send(frame(1)), /not_connected/);
  f.finish(); assertUnknown(f);
});

for (const invalid of ["not json\n", '{"jsonrpc":"2.0","method":7}\n']) {
  test(`fatal framing seals callbacks and closes original process (${invalid.startsWith("not") ? "JSON" : "JSON-RPC"})`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, { script: `process.stdout.write(${JSON.stringify(invalid)});process.stdin.resume();` });
    await f.transport.start(); await until(() => f.errors.length === 1);
    await f.transport.close();
    assert.equal(f.messages.length, 0); assert.equal(f.closes, 1);
    await assert.rejects(f.transport.send(frame(1)), /not_connected/);
    f.finish(); assertUnknown(f);
  });
}

test("stderr is continuously drained without exposing retained secrets or blocking stdout", { timeout: 10_000 }, async t => {
  const secret = "stdio-fixture-private-secret";
  const f = await fixture(t, { env: { PRIVATE_SECRET: secret }, script: `
    process.stderr.write(process.env.PRIVATE_SECRET+'x'.repeat(11*1024*1024),()=>process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n'));
    process.stdin.resume();
  ` });
  await f.transport.start(); await until(() => f.messages.length === 1);
  assert.ok(!JSON.stringify([f.messages, f.errors]).includes(secret));
  await f.transport.close(); f.finish(); assertUnknown(f);
});

test("throwing message/error observers cannot crash, reenter sending or leak raw error text", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { script: `process.stdout.write('{"jsonrpc":"2.0","method":"fixture/ready"}\\n');process.stdin.resume();` });
  f.transport.onmessage = () => { throw new Error("private-observer-secret"); };
  f.transport.onerror = () => { throw new Error("private-error-secret"); };
  await f.transport.start(); await until(() => f.closes === 1);
  assert.ok(!JSON.stringify(f.transport.getCloseObservation()).includes("private-"));
  assert.ok(f.transport.getCloseObservation().cleanupFailures.includes("error_observer_failed"));
  await assert.rejects(f.transport.send(frame(1)), /not_connected/);
  f.finish(); assertUnknown(f);
});

for (const persistent of [false, true]) {
  test(`${persistent ? "persistent" : "once"} unknown settlement failure does not release real stdio blockers`, { timeout: 10_000 }, async t => {
    const f = await fixture(t); await f.transport.start(); await f.transport.close();
    const original = f.store.settleHostOperation.bind(f.store);
    let failed = false;
    f.store.settleHostOperation = (...args) => { if (persistent || !failed) { failed = true; throw new Error("stdio_unknown_write_failed"); } return original(...args); };
    try { assert.throws(() => f.finish()); }
    finally { f.store.settleHostOperation = original; }
    f.tracker.executorGroup.closeAdmission(required);
    assert.equal((await f.tracker.executorGroup.drain()).status, "blocked");
    assert.ok(f.rows().every(row => row.settlementKind !== "known_no_start"));
    if (!persistent) { f.finish(); assertUnknown(f); }
    else assert.ok(f.tracker.executorGroup.getSnapshot().operations.some(row => row.state === "blocked"));
  });
}
