import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

async function withDaemon(config, verify) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-rpc-auth-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0,
    defaultWorkspaceCwd: cwd, ...config });
  try {
    await daemon.start();
    await verify(`ws://127.0.0.1:${daemon.server.address().port}`, cwd);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function initialize(baseUrl, cwd, { headers, query = "", protocols } = {}) {
  const url = `${baseUrl}/rpc/stream?cwd=${encodeURIComponent(cwd)}${query}`;
  const socket = protocols ? new WebSocket(url, protocols, { headers }) : new WebSocket(url, { headers });
  try {
    return await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve({ status: response.statusCode });
      });
      socket.once("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })));
      socket.once("message", bytes => resolve({ status: 101, response: JSON.parse(String(bytes)) }));
    });
  } finally {
    socket.terminate();
  }
}

for (const [name, options] of [
  ["missing bearer", {}],
  ["wrong bearer", { headers: { authorization: "Bearer wrong-token" } }],
  ["matching suffix without bearer scheme", { headers: { authorization: "secret-token" } }],
  ["query token", { query: "&token=secret-token" }],
  ["subprotocol token", { protocols: ["secret-token"] }],
]) {
  test(`RPC upgrade rejects ${name} before initialize when HTTP requires a token`, { timeout: 10_000 }, async () => {
    await withDaemon({ authToken: "secret-token" }, async (baseUrl, cwd) => {
      assert.deepEqual(await initialize(baseUrl, cwd, options), { status: 401 });
    });
  });
}

test("RPC upgrade accepts the same exact bearer credential as HTTP", { timeout: 10_000 }, async () => {
  await withDaemon({ authToken: "secret-token" }, async (baseUrl, cwd) => {
    const result = await initialize(baseUrl, cwd, { headers: { authorization: "Bearer secret-token" } });
    assert.equal(result.status, 101);
    assert.equal(result.response.result.ok, true);
    assert.equal(result.response.result.cwd, cwd);
  });
});

test("loopback RPC without configured authentication retains its existing initialization", { timeout: 10_000 }, async () => {
  await withDaemon({}, async (baseUrl, cwd) => {
    const result = await initialize(baseUrl, cwd);
    assert.equal(result.status, 101);
    assert.equal(result.response.result.ok, true);
  });
});
