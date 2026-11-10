import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  CHROME_BROWSER_DEFAULT_EXTENSION_IDS,
  CHROME_BROWSER_LEGACY_DEVELOPMENT_EXTENSION_ID,
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
  CHROME_BROWSER_MCP_SERVER_ID,
  CHROME_BROWSER_PLUGIN_ID,
  CHROME_BROWSER_PROTOCOL,
} from "@ling-stack/contracts";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("built-in Chrome plugin pairs an allowlisted extension and exposes six MCP tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-chrome-api-"));
  const runner = new ChromeToolRunner();
  assert.deepEqual(CHROME_BROWSER_DEFAULT_EXTENSION_IDS, [
    CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
    CHROME_BROWSER_LEGACY_DEVELOPMENT_EXTENSION_ID,
  ]);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    runner,
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const pluginUrl = `${baseUrl}/plugins/${encodeURIComponent(CHROME_BROWSER_PLUGIN_ID)}`;
  let socket;
  let socketCommandCount = 0;
  try {
    const initial = await getJson(`${baseUrl}/plugins?cwd=${encodeURIComponent(cwd)}`);
    const chrome = initial.plugins.find((plugin) => plugin.id === CHROME_BROWSER_PLUGIN_ID);
    assert.ok(chrome);
    assert.equal(chrome.sourceKind, "built-in");
    assert.equal(chrome.status, "disabled");
    assert.equal(chrome.setup.kind, "browser_extension");
    assert.equal(chrome.setup.browserState, "host_missing");

    const enabled = await postJson(`${pluginUrl}/enable?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(enabled.plugin.status, "enabled");
    assert.equal(enabled.plugin.health.status, "failed");
    assert.equal(enabled.plugin.setup.browserState, "host_missing");
    const lingAgentBindings = await getJson(`${baseUrl}/teammates/ling_agent/mcp?cwd=${encodeURIComponent(cwd)}`);
    const chromeBinding = lingAgentBindings.bindings.find((binding) => binding.serverId === CHROME_BROWSER_MCP_SERVER_ID);
    assert.equal(chromeBinding.mode, "all_current_tools");
    assert.equal(chromeBinding.enabled, true);

    const pairing = await postJson(`${pluginUrl}/pairing?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(pairing.pluginId, CHROME_BROWSER_PLUGIN_ID);
    assert.equal(typeof pairing.pairingCode, "string");

    const forbidden = await fetch(`${baseUrl}/browser-extension/v1/pair?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        pairingCode: pairing.pairingCode,
        extensionVersion: "0.1.0",
      }),
    });
    assert.equal(forbidden.status, 403);

    const paired = await requestJson(`${baseUrl}/browser-extension/v1/pair?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}`,
      },
      body: {
        protocol: CHROME_BROWSER_PROTOCOL,
        pairingCode: pairing.pairingCode,
        extensionVersion: "0.1.0",
        browserVersion: "Chrome/140",
      },
    });
    assert.equal(paired.status, 200);
    assert.equal(typeof paired.json.credential, "string");

    socket = await connectChrome(
      `ws://127.0.0.1:${address.port}/browser-extension/v1/connect?cwd=${encodeURIComponent(cwd)}`,
      paired.json.credential,
    );
    socket.on("message", (data) => {
      socketCommandCount += 1;
      const command = JSON.parse(data.toString());
      socket.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "result",
        id: command.id,
        ok: true,
        result: [{ id: 1, windowId: 1, active: true, title: "Browser", url: "https://example.com" }],
      }));
    });
    await waitFor(async () => {
      const detail = await getJson(`${pluginUrl}?cwd=${encodeURIComponent(cwd)}`);
      return detail.plugin.setup.connected === true;
    });

    const checked = await postJson(`${pluginUrl}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.health.status, "ready");
    assert.equal(checked.plugin.setup.browserState, "ready");

    const tools = await postJson(`${baseUrl}/mcp/servers/${encodeURIComponent(CHROME_BROWSER_MCP_SERVER_ID)}/sync-tools?cwd=${encodeURIComponent(cwd)}`, {});
    assert.deepEqual(tools.tools.map((tool) => tool.rawName).sort(), [
      "chrome_click",
      "chrome_navigate",
      "chrome_screenshot",
      "chrome_snapshot",
      "chrome_tabs",
      "chrome_type",
    ]);
    assert.equal(tools.tools.every((tool) => tool.defaultApproval === "ask"), true);

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        teammateId: "ling_agent",
        task: { id: "chrome_run", title: "Chrome run", prompt: "List Chrome tabs" },
        provider: { provider: "test-provider", model: "test-model" },
        tools: ["read"],
        thinkingLevel: "off",
      }),
    });
    const runTextPromise = runResponse.text();
    assert.equal(runResponse.ok, true);
    let approvalList;
    await waitFor(async () => {
      approvalList = await getJson(`${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending`);
      return approvalList.approvals.length === 1;
    });
    assert.equal(socketCommandCount, 0, "Chrome must not receive a command before MCP approval");
    await postJson(
      `${baseUrl}/approvals/${encodeURIComponent(approvalList.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`,
      { reason: "approved for Chrome integration test" },
    );
    const runText = await runTextPromise;
    assert.equal(runResponse.ok, true, runText);
    assert.equal(socketCommandCount, 1);
    assert.equal(runner.primaryRunCount, 1);
    assert.equal(runner.approvalReviewRunCount, 1);
    assert.equal(runner.chromeToolCount, 6);
    assert.match(runner.chromeResult, /untrusted_web_content/);
    assert.match(runner.chromeResult, /Browser/);

    const revoked = await postJson(`${pluginUrl}/revoke?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(revoked.plugin.status, "disabled");
    assert.equal(revoked.plugin.setup.paired, false);
    assert.equal(revoked.plugin.setup.connected, false);
    const serialized = JSON.stringify(await getJson(`${baseUrl}/plugins?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(serialized.includes(pairing.pairingCode), false);
    assert.equal(serialized.includes(paired.json.credential), false);
  } finally {
    socket?.close();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ChromeToolRunner {
  chromeToolCount = 0;
  chromeResult = "";
  primaryRunCount = 0;
  approvalReviewRunCount = 0;

  async runTask(options) {
    if (options.task.id.startsWith("approval-review:")) {
      this.approvalReviewRunCount += 1;
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.mcpTools, []);
      assert.deepEqual(options.hostCapabilityTools, []);
      assert.deepEqual(options.mediaGenerationTools, []);
      return {
        taskId: options.task.id,
        events: [],
        // Keep the smart reviewer on its fail-closed manual path. This test owns
        // the user approval and only needs to prove that reviewer execution
        // cannot overwrite the primary run's Chrome tool observations.
        messages: [{ role: "assistant", content: "done" }],
      };
    }

    this.primaryRunCount += 1;
    const definition = options.mcpTools.find((tool) => tool.rawName === "chrome_tabs");
    this.chromeToolCount = options.mcpTools.filter((tool) => tool.serverId === CHROME_BROWSER_MCP_SERVER_ID).length;
    assert.ok(definition);
    assert.equal(definition.defaultApproval, "ask");
    assert.ok(options.onApprovalRequired);
    const decision = await options.onApprovalRequired({
      toolCallId: "chrome_tool_call",
      toolName: definition.registeredName,
      input: {},
      task: options.task,
      cwd: options.cwd,
      defaultApproval: definition.defaultApproval,
    });
    assert.equal(decision.approved, true);
    const result = await options.onMcpToolCall({
      registeredName: definition.registeredName,
      toolCallId: "chrome_tool_call",
      serverId: definition.serverId,
      rawName: definition.rawName,
      input: {},
      task: options.task,
      cwd: options.cwd,
      defaultApproval: definition.defaultApproval,
    });
    this.chromeResult = result.content[0]?.text ?? "";
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

function connectChrome(url, credential) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: `chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}` });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        protocol: CHROME_BROWSER_PROTOCOL,
        type: "hello",
        credential,
        extensionVersion: "0.1.0",
        browserVersion: "Chrome/140",
      }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) assert.fail(`${response.status}: ${await response.text()}`);
  return await response.json();
}

async function postJson(url, body) {
  const response = await requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (response.status < 200 || response.status >= 300) assert.fail(`${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, json: await response.json() };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
