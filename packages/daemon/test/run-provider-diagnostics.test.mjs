import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { isRunEventData } from "@ling-stack/contracts";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { resolveConfig } from "../dist/config.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const privateDetail = "PRIVATE_PROVIDER_BODY sk-fixture-secret /private/model-view";
function response(path) {
  const delta = path ? { tool_calls: [{ index: 0, id: "host-first-read", type: "function",
    function: { name: "read", arguments: JSON.stringify({ path }) } }] } : { content: "Read complete." };
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: path ? "tool_calls" : "stop" }] },
  ].map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

for (const outcome of ["succeeded", "failed", "cancelled"]) {
  test(`Host persists real Pi retry ${outcome} without replaying tools or leaking provider text`,
    { timeout: 20_000 }, async t => {
      const cwd = await mkdtemp(join(tmpdir(), "ling-host-provider-diagnostics-"));
      const stores = new RunStoreRegistry(createSqliteRunStore);
      const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
      const activeRuns = new ActiveRunRegistry();
      t.after(async () => { supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
      const path = join(cwd, "read.txt");
      await writeFile(path, "An isolated, already completed read.\n", "utf8");
      const store = stores.getStore(cwd);
      const now = new Date().toISOString();
      const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Isolated retry fixture",
        providerId: "host-provider-diagnostics", model: "fixture", api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false,
        capabilities: ["chat", "tool_call"], enabled: true }, now);
      store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Fixture only", checkedAt: now });
      const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
        title: "Provider diagnostics fixture", objective: "Read once." }, now);
      class FixtureRunner extends PiRunnerAdapter {
        requests = 0;
        lateCallback;
        async prepareTaskInput(options) {
          return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
        }
        async runTask(options) {
          this.lateCallback = options.onEvent;
          return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" },
            onEvent: event => {
              options.onEvent?.(event);
              if (outcome === "cancelled" && event.type === "provider_retry" && event.phase === "scheduled") {
                assert.equal(activeRuns.requestStop(options.runId, { kind: "user_cancel", actor: "local-user",
                  reason: "Cancel isolated retry." }), true);
              }
            },
          });
        }
        registerCustomProviderIfNeeded(runtime, provider) {
          super.registerCustomProviderIfNeeded(runtime, provider);
          runtime.registerProvider(provider.provider, { api: "openai-completions",
            streamSimple: (model, context, options) => stream(model, context, { ...options, maxRetries: 0,
              fetch: async () => {
                this.requests += 1;
                if (this.requests === 1) return response(path);
                if (this.requests === 3 && outcome === "succeeded") return response();
                return new Response(JSON.stringify({ error: { message: privateDetail } }),
                  { status: 503, headers: { "content-type": "application/json" } });
              },
            }),
          });
        }
      }
      const runner = new FixtureRunner();
      const errors = [];
      const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
        providerPresetId: preset.id, tools: ["read"],
        task: { id: "host-provider-diagnostics", title: "Isolated retry", prompt: "Read the file once and finish." },
        idempotencyKey: "host-provider-diagnostics", createdByActor: "local-user",
      }, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
      createRunnerRegistry([{ id: "pi", displayName: "Real Pi SDK fixture", status: "enabled", adapter: runner }]),
      stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});
      assert.ok(runId, JSON.stringify(errors));
      assert.equal(store.getRun(runId)?.status, outcome);
      const events = store.listEvents(runId);
      assert.equal(runner.requests, outcome === "cancelled" ? 2 : 3);
      assert.equal(events.filter(event => event.type === "tool_start").length, 1);
      assert.equal(events.filter(event => event.type === "tool_end").length, 1);
      const retries = events.filter(event => event.type === "provider_retry");
      assert.equal(retries[0]?.data.phase, "scheduled");
      assert.equal(retries[0].data.errorDiagnostic.category, "provider_unavailable");
      assert.ok(retries.every(event => isRunEventData("provider_retry", event.data)));
      const workUnit = store.getWorkUnit(store.getRun(runId).workUnitId);
      assert.ok(workUnit?.activeAttemptId);
      assert.ok(retries.every(event => event.data.attemptId === workUnit.activeAttemptId));
      if (outcome === "cancelled") {
        assert.equal(retries.length, 1, "events after user cancellation are fenced, even SDK cleanup");
        assert.equal(events.filter(event => event.type === "result" || event.type === "run_end").length, 0);
      } else assert.equal(retries.at(-1).data.outcome, outcome === "succeeded" ? "succeeded" : "failed");
      if (outcome === "failed") assert.equal(events.findLast(event => event.type === "run_error")
        ?.data.errorDiagnostic?.httpStatus, 503);
      assert.equal(JSON.stringify(events).includes(privateDetail), false);
      assert.equal(JSON.stringify(store.getRun(runId)).includes(privateDetail), false);
      const count = events.length;
      runner.lateCallback?.({ type: "provider_retry", policyVersion: "pi_sdk_retry_v1", scope: "assistant",
        phase: "settled", retryAttempt: 1, outcome: "succeeded" });
      assert.equal(store.listEvents(runId).length, count, "a late retry cannot reopen a terminal Run");
      assert.equal(store.getRun(runId)?.status, outcome);
    });
}
