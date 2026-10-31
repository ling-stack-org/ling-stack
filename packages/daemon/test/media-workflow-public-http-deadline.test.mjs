import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createA11PublicHttpNetworkFixture } from "./support/a11-public-http-network-fixture.mjs";

const cases = ["dns", "headers", "body"];
const childCase = process.env.LING_A11_PUBLIC_HTTP_DEADLINE_CASE;

function assertIsolation(environment = process.env) {
  for (const name of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
    const value = environment[name];
    assert.ok(value && isAbsolute(value) && resolve(value) === value && value !== process.cwd() && value !== "/");
    assert.ok(statSync(value).isDirectory());
  }
}

async function runChild(caseName) {
  const root = mkdtempSync(join(tmpdir(), `ling-a11-deadline-${caseName}-`));
  const home = join(root, "user"), workspace = join(root, "workspace");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC",
    LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    LING_A11_PUBLIC_HTTP_DEADLINE_CASE: caseName };
  // Match the API launcher: only the fresh child scope is consumed by product
  // imports, and no daily credentials or Node test context are inherited.
  assertIsolation(environment);
  const child = spawn(process.execPath,
    ["--test", "--test-name-pattern=^A11 public HTTP deadline fixture child ", import.meta.filename],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  let expired = false;
  const timeout = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 45_000);
  let status;
  try {
    status = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit); child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
  } finally { clearTimeout(timeout); }
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  assert.equal(expired, false, `${caseName} child exceeded its 45-second bound`);
  assert.match(stdout, new RegExp(`A11 deadline child entered: ${caseName}`));
  assert.deepEqual(status, { code: 0, signal: null }, `${caseName}\n${stdout}\n${stderr}`);
}

if (!childCase) {
  test("A11 Comfy public HTTP actual default deadlines", { concurrency: 3, timeout: 50_000 }, async t => {
    await Promise.all(cases.map(caseName => t.test(`A11 actual 30-second ${caseName} deadline`, { timeout: 47_000 },
      () => runChild(caseName))));
  });
} else {
  test(`A11 public HTTP deadline fixture child ${childCase}`, { timeout: 42_000 }, async t => {
    assertIsolation();
    assert.ok(cases.includes(childCase));
    console.log(`A11 deadline child entered: ${childCase}`);
    console.log(`A11 deadline child scope: ${JSON.stringify({ home: process.env.LING_STACK_HOME,
      workspace: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD })}`);
    const fixture = await createA11PublicHttpNetworkFixture(t, { onRequest(request, response) {
      request.resume();
      assert.equal(request.url, "/api/object_info", "the actual check must stall at its first real Comfy request");
      if (childCase === "body") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "1024" });
        response.write('{"CLIPTextEncode":{');
      }
      // headers: deliberately send no headers. body: deliberately do not reach
      // EOF. These are real server stalls; no fake fetch or shortened timer.
    } });
    let daemon;
    try {
      // Import only after the fixture is installed, with both fresh scope envs
      // already present: Daemon startup creates a real isolated SQLite store.
      const { createDaemonServer } = await import("../dist/index.js");
      daemon = createDaemonServer({ host: "127.0.0.1", port: 0,
        defaultWorkspaceCwd: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD }, {
        runner: { runTask() { throw new Error("A11 deadline QA must never execute a model"); } },
      });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      fixture.allowApiPort(address.port);
      const api = `http://127.0.0.1:${address.port}`;
      const cwd = encodeURIComponent(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD);
      const createdResponse = await fetch(`${api}/media-workflow-connections?cwd=${cwd}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `A11 actual deadline ${childCase}`, baseUrl: fixture.baseUrl,
          authMode: "none", networkPolicy: "public_only", protocolVariant: "prompt_legacy" }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      const route = `${api}/media-workflow-connections/${encodeURIComponent(created.connection.id)}`;
      if (childCase === "dns") fixture.setDnsStall();
      const began = performance.now();
      const checkedResponse = await fetch(`${route}/check?cwd=${cwd}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(38_000),
      });
      const checked = await checkedResponse.json();
      const elapsedMs = performance.now() - began;
      assert.equal(checkedResponse.status, 200, "connection check preserves its HTTP 200 envelope on a failed health result");
      assert.equal(checked.connection.status, "error");
      assert.equal(checked.connection.health.ok, false);
      assert.equal(typeof checked.connection.health.message, "string");
      assert.ok(checked.connection.health.message.length > 0);
      assert.ok(elapsedMs >= 28_000 && elapsedMs < 36_000, `actual default 30-second deadline elapsed ${elapsedMs}ms`);
      const upstream = fixture.connects.filter(connect => connect.kind === "upstream");
      assert.equal(fixture.dnsLookups.filter(lookup => lookup.kind === "approval").length, 1);
      assert.equal(fixture.dnsLookups.filter(lookup => lookup.kind === "sender").length, 0);
      assert.equal(upstream.length, childCase === "dns" ? 0 : 1);
      assert.equal(fixture.requests.length, childCase === "dns" ? 0 : 1);
      if (childCase === "dns") {
        assert.equal(fixture.pendingDnsLookups, 1, "the real resolver remains withheld when the request deadline wins");
        assert.equal(fixture.releaseDnsStall(), 1);
        assert.equal(fixture.pendingDnsLookups, 0);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
        assert.equal(fixture.connects.filter(connect => connect.kind === "upstream").length, 0,
          "a late DNS answer cannot launch a timed-out request");
      }
      const persistedResponse = await fetch(`${route}?cwd=${cwd}`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(persistedResponse.status, 200);
      const persisted = await persistedResponse.json();
      assert.equal(persisted.connection.status, "error");
      assert.deepEqual(persisted.connection.health, checked.connection.health);
      console.log(`A11 actual Comfy default deadline evidence: ${JSON.stringify({ case: childCase,
        elapsedMs, expectedTimeoutMs: 30_000, httpStatus: checkedResponse.status,
        connectionStatus: checked.connection.status, health: checked.connection.health,
        upstreamConnects: upstream, upstreamRequests: fixture.requests, dnsLookups: fixture.dnsLookups,
        pendingDnsLookups: fixture.pendingDnsLookups, persistedStatus: persisted.connection.status })}`);
    } finally {
      // No restoration of global network guards while this owned Daemon is live.
      try { await daemon?.stop(); } finally { await fixture.close(); }
    }
  });
}
