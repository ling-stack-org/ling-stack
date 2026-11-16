import assert from "node:assert/strict";
import test from "node:test";
import { CuaDriverMcpProxy, deriveCuaDriverWorkspaceBinding } from "../dist/main/cua-driver/mcp-proxy.js";
import type { CuaDriverProviderHost, JsonRpcClientMessage, JsonRpcResponse } from "../dist/main/cua-driver/provider-host.js";
import type { CuaDriverActionGate } from "../dist/main/cua-driver/restricted-generation.js";
import { deferred } from "./locked-use-fixtures.ts";

async function fixture(gate: CuaDriverActionGate, exchangeCall?: () => Promise<void>, boundary?: (proxy: CuaDriverMcpProxy) => Promise<void>) {
  const calls: JsonRpcClientMessage[] = [];
  const host = {
    onServerMessage() { return () => {}; },
    async stop() {},
    async exchange(message: JsonRpcClientMessage): Promise<JsonRpcResponse | undefined> {
      calls.push(message);
      if (!("id" in message)) return undefined;
      if ("method" in message && message.method === "initialize") {
        return { jsonrpc: "2.0", id: message.id!, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } };
      }
      await exchangeCall?.();
      return { jsonrpc: "2.0", id: message.id!, result: { content: [{ type: "text", text: "sensitive-result" }] } };
    },
  } as unknown as CuaDriverProviderHost;
  const context = { bridgeToken: "bridge-secret", daemonAuthorityEpoch: "epoch", bridgeConnectionId: "connection", desktopInstanceEpoch: 1, generation: 4, workspaceCwd: "/workspace" };
  const proxy = new CuaDriverMcpProxy({ host, context, actionGate: gate, onInitialized: () => boundary?.(proxy) });
  const endpoint = await proxy.start();
  const headers: Record<string, string> = {
    "content-type": "application/json", authorization: `Bearer ${endpoint.authorizationToken}`,
    "x-ling-cua-driver-generation": "4", "x-ling-cua-driver-authority-epoch": "epoch",
    "x-ling-cua-driver-workspace-sha256": deriveCuaDriverWorkspaceBinding(context.workspaceCwd),
    "x-ling-cua-driver-instance-epoch": "1", "x-ling-cua-driver-bridge-connection": "connection",
  };
  const post = (message: unknown) => fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(message) });
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
  const initializeBody = await initialized.text();
  if (!boundary) assert.equal(initialized.status, 200, initializeBody);
  headers["mcp-session-id"] = initialized.headers.get("mcp-session-id")!;
  return { proxy, calls, post, initializeStatus: initialized.status, initializeBody };
}

test("proxy awaits native admission and releases it even when the security gate closes before dispatch", async () => {
  const entered = deferred(); const release = deferred(); let finishes = 0;
  const fx = await fixture({ async beforeCall(message) {
    if ("method" in message && message.method === "tools/call") { entered.resolve(); await release.promise; }
    return async () => { finishes += 1; };
  } });
  try {
    const calling = fx.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture" } });
    await entered.promise;
    assert.equal(fx.calls.length, 1);
    fx.proxy.closeCallGate("locked"); release.resolve();
    const response = await calling;
    assert.match(await response.text(), /mcp_call_gate_closed/u);
    assert.equal(fx.calls.length, 1);
    assert.equal(finishes, 2);
  } finally { await fx.proxy.close("done"); }
});

test("proxy drops a result when revocation occurs after provider dispatch", async () => {
  const entered = deferred(); const release = deferred(); let finishes = 0;
  const fx = await fixture({ async beforeCall() { return async () => { finishes += 1; }; } }, async () => { entered.resolve(); await release.promise; });
  try {
    const calling = fx.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture" } });
    await entered.promise;
    fx.proxy.closeCallGate("revoked"); release.resolve();
    const text = await (await calling).text();
    assert.match(text, /mcp_call_gate_closed/u);
    assert.doesNotMatch(text, /sensitive-result/u);
    assert.equal(finishes, 2);
  } finally { await fx.proxy.close("done"); }
});

test("late initialize readiness cannot reopen a revoked restricted proxy", async () => {
  const fx = await fixture({ async beforeCall() { return async () => {}; } }, undefined, async (proxy) => {
    proxy.closeCallGate("native_revoked");
    await Promise.resolve();
    proxy.openCallGate();
  });
  try {
    assert.equal(fx.initializeStatus, 400);
    assert.match(fx.initializeBody, /mcp_call_gate_closed/u);
    fx.proxy.openCallGate();
    const retry = await fx.post({ jsonrpc: "2.0", id: 2, method: "initialize" });
    assert.match(await retry.text(), /mcp_call_gate_closed/u);
    assert.equal(fx.calls.length, 1);
  } finally { await fx.proxy.close("done"); }
});
