import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DESKTOP_BROWSER_MCP_SERVER_ID, DESKTOP_BROWSER_PLUGIN_ID, DESKTOP_BROWSER_PROTOCOL,
  type DesktopBrowserCommand, type DesktopBrowserState } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions, PiRunnerResult } from "@ling-stack/runner-pi";
import { createDaemonServer } from "../dist/index.js";

test("Desktop browser bridge authenticates its runtime and uses existing MCP approval before dispatch", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-browser-api-"));
  const token = "browser-api-fixture-token", runner = new BrowserRunner();
  let store: RunStore | undefined;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner, desktopBridgeToken: token, onStoreInitialized: (_cwd, value) => { store = value; },
  });
  await daemon.start();
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const pluginPath = `/plugins/${encodeURIComponent(DESKTOP_BROWSER_PLUGIN_ID)}`;
  const bridge = "/desktop/capabilities/browser";
  const request = async (path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    return { status: response.status, data: await response.json() };
  };
  const authority = { "x-ling-desktop-bridge-token": token, "x-ling-browser-instance": "desktop-fixture", "x-ling-browser-generation": "1" };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await request(path, body, headers); assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
  };
  const get = async (path: string) => { const response = await fetch(`${base}${path}`); assert.equal(response.status, 200); return response.json(); };
  const query = `?cwd=${encodeURIComponent(cwd)}`;
  const enabled = await post(`${pluginPath}/enable${query}`, {});
  assert.equal(enabled.health.status, "failed");
  assert.equal(enabled.health.details.browserState, "desktop_required");
  assert.ok(store);
  const thread = store.createLingThread({ kind: "conversation", title: "Browser fixture", objective: "List tabs" }, new Date().toISOString());
  const scope = { surface: "normal_conversation" as const, ownerId: thread.id };
  const state: DesktopBrowserState = { protocol: DESKTOP_BROWSER_PROTOCOL, desktopInstanceId: "desktop-fixture", generation: 1, revision: 1, workspaceCwd: cwd,
    tabs: [{ id: "fixture-tab", scope, url: "http://localhost:3000/", title: "Fixture preview", navigationRevision: 1, loading: false, canGoBack: false, canGoForward: false, control: "agent" }] };
  assert.equal((await request(`${bridge}/availability`, state)).status, 403);
  assert.equal((await request(`${bridge}/availability`, state, { ...authority, origin: "https://example.com" })).status, 403);
  assert.equal((await request(`${bridge}/availability`, { ...state, workspaceCwd: "/other" }, authority)).status, 409);
  const published = await post(`${bridge}/availability`, state, authority); assert.equal(typeof published.runtimeId, "string");
  const checked = await post(`${pluginPath}/check${query}`, {}); assert.equal(checked.health.status, "ready");
  const tools = await post(`/mcp/servers/${DESKTOP_BROWSER_MCP_SERVER_ID}/sync-tools${query}`, {});
  assert.equal(tools.tools.length, 6); assert.ok(tools.tools.every((tool: { defaultApproval: string }) => tool.defaultApproval === "ask"));
  const bindings = await get(`/teammates/ling_agent/mcp${query}`);
  assert.equal(bindings.bindings.find((binding: { serverId: string }) => binding.serverId === DESKTOP_BROWSER_MCP_SERVER_ID)?.enabled, true);

  let dispatched = 0, mayDispatch = false;
  const abort = new AbortController();
  const worker = (async () => {
    while (!abort.signal.aborted) {
      const reply = await request(`${bridge}/commands/claim`, {}, authority, abort.signal);
      if (abort.signal.aborted) break;
      assert.equal(reply.status, 200);
      const command = reply.data.command as DesktopBrowserCommand | undefined;
      if (!command) continue;
      assert.ok(mayDispatch, "a browser command cannot reach Desktop before approval");
      dispatched++;
      assert.deepEqual(command.scope, scope);
      await post(`${bridge}/commands/${command.id}/start`, {}, authority);
      const result = { protocol: DESKTOP_BROWSER_PROTOCOL, id: command.id, ok: true, effect: "none", result: state.tabs };
      assert.equal((await request(`${bridge}/commands/${command.id}/result`, result, { ...authority, "x-ling-browser-generation": "2" })).status, 409);
      await post(`${bridge}/commands/${command.id}/result`, result, authority);
      assert.equal((await request(`${bridge}/commands/${command.id}/result`, result, authority)).status, 409);
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
  t.after(async () => { abort.abort(); await worker; });
  for (const decision of ["approve", "deny"] as const) {
    const run = await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      cwd, threadId: thread.id, teammateId: "ling_agent", task: { id: `browser-${decision}`, title: "Browser test", prompt: "List browser tabs" },
      provider: { provider: "test-provider", model: "test-model" }, tools: ["read"], thinkingLevel: "off",
    }) });
    assert.equal(run.status, 200); const stream = run.text();
    let approvals: { id: string }[] = [];
    await waitFor(async () => { approvals = (await get(`/approvals${query}&status=pending`)).approvals; return approvals.length === 1; });
    assert.equal(dispatched, decision === "approve" ? 0 : 1);
    mayDispatch = decision === "approve";
    await post(`/approvals/${approvals[0]!.id}/${decision}${query}`, { reason: "Browser integration fixture" });
    const text = await stream; assert.doesNotMatch(text, /browser_conversation_scope_required|mcp_host_admission_unsupported/u);
  }
  assert.equal(dispatched, 1);
  assert.deepEqual(runner.decisions, [true, false]);
  assert.match(runner.result, /untrusted_web_content/u); assert.match(runner.result, /Fixture preview/u);
  const disabled = await post(`${pluginPath}/disable${query}`, {}); assert.equal(disabled.health.status, "disabled");
  abort.abort(); await worker;
});

class BrowserRunner {
  decisions: boolean[] = [];
  result = "";
  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    if (!options.task.id.startsWith("approval-review:")) {
      const tool = options.mcpTools?.find(tool => tool.rawName === "browser_tabs"); assert.ok(tool);
      const request = { toolCallId: `call-${options.task.id}`, toolName: tool.registeredName, input: {}, task: options.task,
        cwd: options.cwd, defaultApproval: tool.defaultApproval };
      assert.ok(options.onApprovalRequired); const decision = await options.onApprovalRequired(request);
      this.decisions.push(decision.approved);
      if (decision.approved) {
        assert.ok(options.onMcpToolCall);
        const result = await options.onMcpToolCall({ ...request, registeredName: tool.registeredName, serverId: tool.serverId, rawName: tool.rawName });
        this.result = result.content?.find(item => item.type === "text")?.text ?? "";
      }
    }
    return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "done" }] };
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) assert.fail("Browser fixture did not reach the expected state"); await delay(20); }
}
