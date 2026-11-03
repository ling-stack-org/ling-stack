import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCompositeSecretResolver, createSqliteWorkflowUserCreationStore } from "@ling-stack/core";
import { stream } from "../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../../dist/index.js";
import { terminalReportsEnabledForStore } from "../../dist/features/channels/terminal-report-coordinator.js";
import { TERMINAL_REPORT_PROMPT_VERSION } from "../../dist/features/channels/terminal-report-prompt.js";
import { ToolFreePiRunner } from "./tool-free-pi-runner.mjs";

/** Original Pi SDK Runs and Host tools, with in-memory model transport and loopback-only HTTP. */
export async function openWorkflowRecoveryDaemon(t, f, { terminalReports = false } = {}) {
  const executions = new Map(), contexts = new AsyncLocalStorage();
  const reportRequests = [], forbiddenAccess = [];
  let workflowId;
  class RecoveryPiRunner extends ToolFreePiRunner {
    async runTask(options) {
      if (terminalReports && options.runId === undefined) {
        reportRequests.push({ title: options.task.title, cwd: options.cwd, tools: options.tools });
        // Exercise the production deterministic fallback without any model transport.
        throw new Error("recovery-fixture-terminal-report-fallback");
      }
      const run = f.store.getRun(options.runId), step = f.store.getChannelWorkflowStep(run.workflowStepId);
      assert.ok(workflowId, "No execution is authorized before the explicit Advance");
      assert.equal(step.workflowId, workflowId);
      assert.equal(executions.has(step.id), false, "Only one original Run per fresh recovery step");
      assert.equal(options.isolatedToolsProfile, "host_isolated_files_v1");
      assert.notEqual(options.cwd, f.cwd);
      assert.deepEqual([...options.tools].sort(), ["read", "write"]);
      for (const key of ["mcpTools", "hostCapabilityTools", "mediaGenerationTools"]) assert.deepEqual(options[key], []);
      const execution = { runId: run.id, stepId: step.id, requests: [], results: [] };
      executions.set(step.id, execution);
      return contexts.run(execution, () => super.runTask({ ...options,
        onIsolatedToolCall: async request => {
          const result = await options.onIsolatedToolCall(request);
          execution.results.push({ request, result });
          return result;
        },
      }));
    }

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async (_url, request) => {
            const execution = contexts.getStore();
            assert.ok(execution, "SDK transport must belong to an explicitly started original Run");
            const step = f.store.getChannelWorkflowStep(execution.stepId), body = JSON.parse(request.body);
            const index = execution.requests.length;
            execution.requests.push(body);
            assert.deepEqual((body.tools ?? []).map(tool => tool.function.name).sort(), ["read", "write"]);
            assert.match(JSON.stringify(body.messages), /Preserve left in shared\.txt; move right to right\.txt\./);
            if (index === 0) {
              assert.equal(execution.results.length, 0);
              const left = step.metadata.graphNodeId === "left";
              return sse({ tool_calls: [{ index: 0, id: `repair-${step.id}`, type: "function", function: { name: "write",
                arguments: JSON.stringify({ path: left ? "shared.txt" : "right.txt", content: left ? "repaired left\n" : "repaired right\n" }) } }] }, "tool_calls");
            }
            assert.equal(index, 1, "No extra model work may escape the bounded repair");
            assert.equal(execution.results.length, 1);
            assert.notEqual(execution.results[0].result.isError, true, JSON.stringify(execution.results));
            assert.equal(body.messages.filter(message => message.role === "tool").length, 1);
            return sse({ content: "Completed the explicit isolated conflict repair." }, "stop");
          },
        }),
      });
    }
  }

  const providerId = f.store.getChannel(f.channel.id).defaultProviderPresetId;
  f.store.recordProviderCheckResult(providerId, { ok: true, code: "ready", message: "In-memory SDK fixture; no external probe", checkedAt: new Date().toISOString() });
  let reportProbe;
  if (terminalReports) {
    assert.deepEqual(f.store.listChannelWorkflows({ channelId: f.channel.id, limit: 500 }), [],
      "Start the report-enabled daemon before constructing the conflict; startup recovery must not observe its retirement");
    const now = new Date().toISOString();
    reportProbe = createSqliteWorkflowUserCreationStore(f.store).create({ channelId: f.channel.id, now,
      compile: () => ({ workflow: f.store.createChannelWorkflow({ channelId: f.channel.id,
        title: "TerminalReport fixture health", objective: "Publish a local failed workflow report", status: "failed", createdBy: "local-user" }, now),
      workflowSteps: [] }) }).workflow;
  }
  const denySecrets = () => {
    forbiddenAccess.push("external credentials");
    assert.fail("Recovery fixture must not access external credentials");
  };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
    transports: { localWebSocketRpc: false }, harness: { toolBroker: { mode: "enforce" } },
    channels: { autoRoute: false, intentSelector: false, terminalReports, teamObserverBus: false, workflowIsolatedFiles: true },
    cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
  }, { runner: new RecoveryPiRunner(), chromeBrowserNativeMessagingEnabled: false,
    secretResolver: createCompositeSecretResolver({ env: {} }),
    externalSecretStore: { status: denySecrets, resolve: denySecrets, setSecret: denySecrets, deleteSecret: denySecrets },
    storeFactory(cwd) { assert.equal(cwd, f.cwd); return f.store; },
  });
  f.addCleanup(() => daemon.stop());
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") forbiddenAccess.push(`external fetch: ${url.hostname}`);
    assert.equal(url.hostname, "127.0.0.1", "Recovery fixture forbids all external fetches");
    return fetch(input, init);
  });
  await daemon.start();
  const base = `http://127.0.0.1:${daemon.server.address().port}`;
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await globalThis.fetch(`${base}${path}?cwd=${encodeURIComponent(f.cwd)}`, { method,
      signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const participant = await api("/teammates/teammate_builtin_engineer", { providerPresetId: providerId, allowedTools: ["read", "write"] }, "PATCH");
  assert.equal(participant.status, 200, JSON.stringify(participant));
  const assertReportFixture = () => {
    assert.deepEqual(forbiddenAccess, [], "Report fallback must not hide forbidden fixture access");
    if (!terminalReports) return;
    assert.equal(terminalReportsEnabledForStore(f.store), true, "Fixture must enable the production report coordinator");
    for (const request of reportRequests) {
      assert.equal(request.title, `Terminal report ${TERMINAL_REPORT_PROMPT_VERSION}`);
      assert.equal(request.cwd, f.cwd);
      assert.deepEqual(request.tools, []);
    }
  };
  if (reportProbe) {
    const reports = () => f.store.listTerminalReports({ sourceKind: "workflow", sourceId: reportProbe.id, limit: 20 });
    await untilRecovery(() => Boolean(reports()[0]?.resultItemId), "fixture health report publication before any conflict exists",
      () => ({ workflow: f.store.getChannelWorkflow(reportProbe.id), reports: reports(), reportRequests, forbiddenAccess }));
    assertReportFixture();
    assert.equal(reports().length, 1, "Fixture health publication must not need a restart or manual coordinator call");
    assert.equal(reports()[0].report.synthesis.mode, "deterministic_fallback");
    assert.equal(reportRequests.length, 1, "The local report provider must reach the controlled fallback");
    assert.equal(f.store.getLingTurn(reportProbe.metadata.sourceTurnId).status, "failed");
    const detail = await api(`/terminal-reports/${reports()[0].id}`);
    assert.equal(detail.status, 200, `Fixture health report must be HTTP-readable: ${JSON.stringify(detail)}`);
    assert.equal(detail.body.report.id, reports()[0].id);
  }
  return { api, executions, reportProbe, reportRequests, assertReportFixture, allowAdvance(id) { workflowId = id; } };
}

function sse(delta, finishReason) {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

export async function untilRecovery(predicate, label, describe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(describe())}`);
}
