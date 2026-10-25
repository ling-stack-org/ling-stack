import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQaSseFaultRelay } from "../scripts/qa-sse-fault-relay.mjs";
import { buildQaGuiEnvironment, readExistingPrivateToken } from "../scripts/qa-sse-supervisor-support.mjs";

// QA transport regression: a control-only cut does not prove execution SSE loss.
// No model, GUI or actual tool execution is represented by this loopback fixture.
async function fixture(t) {
  let executions = 0;
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/control-plane/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: control_plane_replay_ready\ndata: {"disposition":"complete","nextAfterSeq":17,"private":"never-retained"}\n\n');
    } else if (request.method === "POST" && url.pathname === "/conversations/stream") {
      executions += 1;
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: ready\ndata: {"private":"never-retained"}\n\n');
    } else { request.resume(); response.writeHead(200).end(JSON.stringify({ executions })); }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const relay = await createQaSseFaultRelay({ upstreamPort: upstream.address().port });
  t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const base = `http://127.0.0.1:${relay.port}`;
  const connect = async (kind, afterSeq = 12) => {
    const response = await fetch(kind === "control" ? `${base}/control-plane/stream?afterSeq=${afterSeq}&private=never-retained` : `${base}/conversations/stream`, {
      ...(kind === "execution" ? { method: "POST", body: "never-retained" } : {}),
      headers: { "X-Fixture-Private": "never-retained" }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    return reader;
  };
  return { relay, base, connect, state: async () => (await fetch(`${base}/health`)).json() };
}

test("fault requires both established SSE routes, then breaks both and refuses new executions while held", async t => {
  const f = await fixture(t);
  assert.throws(() => f.relay.disconnect(), /live successful control/);
  const control = await f.connect("control");
  assert.throws(() => f.relay.disconnect(), /live successful execution/);
  assert.equal((await f.state()).executions, 0);
  const execution = await f.connect("execution");
  const before = f.relay.liveStreams();
  assert.deepEqual(before.map(stream => stream.kind), ["control", "execution"]);
  assert.ok(before.every(stream => stream.ready && stream.bytesReceived > 0));
  assert.equal((await f.state()).executions, 1);
  const cut = f.relay.disconnect();
  assert.deepEqual(cut, before.map(({ id, kind }) => ({ id, kind })));
  await assert.rejects(control.read());
  await assert.rejects(execution.read());
  assert.throws(() => f.relay.disconnect(), /repeated fault/);
  assert.equal((await fetch(`${f.base}/control-plane/stream?afterSeq=18`)).status, 503);
  assert.equal((await fetch(`${f.base}/conversations/stream`, { method: "POST", body: "not-forwarded" })).status, 503);
  assert.equal((await f.state()).executions, 1, "held POST must not reach the execution handler");
  f.relay.restore();
  assert.throws(() => f.relay.restore(), /prior fault/);
  const restored = await f.connect("control", 18);
  assert.ok(f.relay.liveStreams().some(stream => stream.kind === "control" && stream.afterSeq === 18 && !cut.some(old => old.id === stream.id)));
  assert.ok(f.relay.records.some(row => row.event === "control-frame" && row.type === "control_plane_replay_ready" && row.nextAfterSeq === 17));
  assert.equal((await f.state()).executions, 1, "restoring transport must not replay a POST");
  await restored.cancel();
});

test("transport records exclude bodies, headers, arbitrary query values and SSE payload text", async t => {
  const f = await fixture(t);
  const control = await f.connect("control");
  const execution = await f.connect("execution");
  await control.cancel(); await execution.cancel();
  assert.ok(!JSON.stringify(f.relay.records).includes("never-retained"));
  assert.ok(f.relay.records.some(row => row.event === "stream-request" && row.afterSeq === 12));
  assert.ok(f.relay.records.some(row => row.event === "control-frame" && row.nextAfterSeq === 17));
});

test("relay rejects invalid or self-loop upstream ports", async () => {
  for (const upstreamPort of [0, -1, 65536, 1.5, "17930"]) {
    await assert.rejects(createQaSseFaultRelay({ upstreamPort }));
  }
  await assert.rejects(createQaSseFaultRelay({ upstreamPort: 17930, port: 17930 }));
});

// Regression: R02-QA-001 — malformed private identity must not appear in exceptions.
// Found by /qa independent review on 2026-10-26; synthetic token file, not live profile.
test("private QA identity reader rejects malformed contents without exposing them", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ling-r02-token-regression-")));
  const path = join(directory, "synthetic-identity");
  const malformed = "fixture_private_value_that_must_not_be_exposed!";
  await writeFile(path, malformed, { flag: "wx", mode: 0o600 });
  await assert.rejects(readExistingPrivateToken(path), error => {
    assert.ok(!String(error.stack).includes(malformed), "exception stack must not expose private input");
    assert.ok(!JSON.stringify(error).includes(malformed), "exception properties must not expose private input");
    return true;
  });
  assert.equal(await readFile(path, "utf8"), malformed, "rejection must not rotate or rewrite identity");
});

test("private QA identity reader accepts existing protected valid input without writing it", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ling-r02-token-happy-")));
  const path = join(directory, "synthetic-identity");
  const valid = "synthetic_only_not_a_real_bridge_identity_20261026";
  await writeFile(path, valid, { flag: "wx", mode: 0o600 });
  assert.equal(await readExistingPrivateToken(path), valid);
  assert.equal(await readFile(path, "utf8"), valid);
});

// Regression: R02-QA-002 — the Node-mode supervisor must launch a real GUI child.
// Found by /qa on 2026-10-26; report r02-recovery-successor-20261026.
test("GUI child does not inherit supervisor Node mode or mutate its parent environment", () => {
  const parent = Object.freeze({ ELECTRON_RUN_AS_NODE: "1", PATH: "/synthetic/bin", LING_QA_SYNTHETIC: "retained" });
  const child = buildQaGuiEnvironment(parent);
  assert.equal(Object.hasOwn(child, "ELECTRON_RUN_AS_NODE"), false);
  assert.deepEqual(child, { PATH: "/synthetic/bin", LING_QA_SYNTHETIC: "retained" });
  assert.equal(parent.ELECTRON_RUN_AS_NODE, "1");
  assert.notEqual(child, parent);
  assert.deepEqual(buildQaGuiEnvironment(Object.freeze({ PATH: "/synthetic/bin" })), { PATH: "/synthetic/bin" });
});
