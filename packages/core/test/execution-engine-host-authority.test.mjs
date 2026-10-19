import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import * as authority from "../dist/execution-engine-host-authority.js";

const baseUrl = "http://127.0.0.1:17892";
const credentials = { capability: "x".repeat(43), csrfToken: "y".repeat(43) };

test("host authority transfers only over the owned child's dedicated pipe", async () => {
  assert.equal(typeof authority.writeExecutionEngineHostAuthority, "function");
  const moduleUrl = new URL("../dist/execution-engine-host-authority.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { writeExecutionEngineHostAuthority } from ${JSON.stringify(moduleUrl)};
     writeExecutionEngineHostAuthority({ fd: 3, baseUrl: ${JSON.stringify(baseUrl)}, credentials: ${JSON.stringify(credentials)} });`],
  { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  try {
    const value = await authority.readExecutionEngineHostAuthority({ channel: child.stdio[3], baseUrl, pid: child.pid });
    assert.deepEqual(value.credentials, credentials);
    assert.equal(value.pid, child.pid);
    assert.deepEqual(await exited, [0, null]);
    assert.equal(output, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
});

test("launch authority rejects another child, another endpoint and malformed or oversized records", async () => {
  const valid = { schemaVersion: 1, instanceId: "11111111-1111-1111-1111-111111111111", baseUrl, pid: 42, credentials };
  for (const body of ["not-json", "x".repeat(9000), JSON.stringify({ ...valid, pid: 43 }),
    JSON.stringify({ ...valid, baseUrl: "http://127.0.0.1:17891" }), JSON.stringify({ ...valid, credentials: { capability: "secret-fixture" } })]) {
    const channel = new PassThrough();
    const result = authority.readExecutionEngineHostAuthority({ channel, baseUrl, pid: 42 });
    channel.end(body);
    await assert.rejects(result, { code: "engine_host_authority_invalid" });
    assert.equal(channel.destroyed, true);
  }
  assert.throws(() => authority.writeExecutionEngineHostAuthority({ fd: 1, baseUrl, credentials }), { code: "engine_host_authority_invalid" });
  assert.throws(() => authority.readExecutionEngineHostAuthority({ channel: new PassThrough(), baseUrl: "https://remote.example", pid: 42 }), { code: "engine_host_must_be_local" });
});

test("a stalled, failed or closed startup pipe cannot leave a pending authority request", async () => {
  const channel = new PassThrough();
  await assert.rejects(authority.readExecutionEngineHostAuthority({ channel, baseUrl, pid: 42, timeoutMs: 10 }), { code: "engine_host_authority_unavailable" });
  assert.equal(channel.destroyed, true);
  const failed = new PassThrough();
  const result = authority.readExecutionEngineHostAuthority({ channel: failed, baseUrl, pid: 42 });
  failed.destroy(new Error("raw-sensitive-fixture"));
  await assert.rejects(result, { message: "engine_host_authority_unavailable" });
  const closed = new PassThrough();
  closed.destroy();
  await assert.rejects(authority.readExecutionEngineHostAuthority({ channel: closed, baseUrl, pid: 42 }), { code: "engine_host_authority_unavailable" });
});
