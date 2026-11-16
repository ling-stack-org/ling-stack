import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { connectLockedUseValidationTransport } from "../dist/main/locked-computer-control/validation-transport.js";
import { deriveCuaDriverProxyToken, deriveCuaDriverWorkspaceBinding } from "../dist/main/cua-driver/mcp-proxy.js";

const context = { bridgeToken: "private-test-bridge", daemonAuthorityEpoch: "epoch", bridgeConnectionId: "connection",
  desktopInstanceEpoch: 1, generation: 2, workspaceCwd: "/owned-fixture" };

test("candidate MCP transport retains the authenticated generation and session through initialization and fixed calls", async t => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + deriveCuaDriverProxyToken(context));
    assert.equal(request.headers["x-ling-cua-driver-workspace-sha256"], deriveCuaDriverWorkspaceBinding(context.workspaceCwd));
    assert.equal(request.headers["x-ling-cua-driver-generation"], "2");
    assert.equal(request.headers["x-ling-cua-driver-authority-epoch"], "epoch");
    assert.equal(request.headers["x-ling-cua-driver-instance-epoch"], "1");
    assert.equal(request.headers["x-ling-cua-driver-bridge-connection"], "connection");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(value.method);
    if (value.method === "initialize") assert.equal(request.headers["mcp-session-id"], undefined);
    else assert.equal(request.headers["mcp-session-id"], "owned-session");
    response.setHeader("mcp-session-id", "owned-session");
    if (value.method === "notifications/initialized") { response.writeHead(202); response.end(); }
    else response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: value.method === "tools/call" ? { content: [] } : {} }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/mcp";
  const call = await connectLockedUseValidationTransport({ endpoint, context, signal: AbortSignal.timeout(3000) });
  assert.deepEqual(await call("get_window_state", { pid: 321, window_id: 456 }), { content: [] });
  assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/call"]);
});

test("candidate transport rejects non-loopback endpoints before connecting", async () => {
  for (const endpoint of ["https://127.0.0.1/mcp", "http://example.com/mcp", "http://127.0.0.1/other",
    "http://user:password@127.0.0.1/mcp", "http://127.0.0.1/mcp?target=other"]) {
    await assert.rejects(connectLockedUseValidationTransport({ endpoint, context, signal: new AbortController().signal }), /endpoint_invalid/u);
  }
});

test("candidate transport rejects MCP errors without exposing a callable session", async t => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("mcp-session-id", "owned-session");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, error: { code: -32003, message: "closed" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await assert.rejects(connectLockedUseValidationTransport({
    endpoint: "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/mcp", context, signal: AbortSignal.timeout(3000),
  }), /mcp_error/u);
});
