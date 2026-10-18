import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../../dist/features/runs/orchestrator.js";
import { resolveConfig } from "../../dist/config.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../../dist/runtime/runners.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";

const cwd = process.argv[2];
if (!cwd || !process.send) throw new Error("Crash fixture requires an isolated cwd and IPC parent.");
const mode = ["cancel", "initial-crash"].includes(process.argv[3]) ? process.argv[3] : "crash";

function fixtureResponse({ toolCallId, name, args, text, inputTokens = 32_000 }) {
  const delta = toolCallId
    ? { tool_calls: [{ index: 0, id: toolCallId, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] }
    : { content: text };
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCallId ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 16, total_tokens: inputTokens + 16 } },
  ];
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

class CrashAtProviderBoundaryRunner extends PiRunnerAdapter {
  taskRequests = 0;
  summaryRequests = 0;
  compacting = false;
  wroteMarker = false;

  async prepareTaskInput(options) {
    return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
  }

  async runTask(options) {
    return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" },
      onEvent: (event) => {
        if (event.type === "context_compaction_start") this.compacting = true;
        if (event.type === "context_compaction_end") this.compacting = false;
        options.onEvent?.(event);
        if (event.type === "tool_end" && event.toolName === "write" && !event.isError) this.wroteMarker = true;
      },
      onTaskContinuationBoundary: async (point, modelView) => {
        await options.onTaskContinuationBoundary?.(point, modelView);
        if (point !== "before_provider_request"
          || (mode === "initial-crash" ? this.summaryRequests === 0 : !this.wroteMarker)) return;
        const checkpoint = store.getLatestRunCompactionCheckpoint(options.runId);
        const writeEnd = store.listEvents(options.runId).findLast((event) => event.type === "tool_end"
          && event.data.toolName === "write" && !event.data.isError);
        if (!checkpoint || (mode !== "initial-crash" && (!writeEnd || checkpoint.sourceEventSeq < writeEnd.seq))) {
          throw new Error("Host did not seal the expected checkpoint before provider admission.");
        }
        let cancelled;
        if (mode === "cancel") {
          process.on("message", (message) => {
            if (message?.type === "cancel") {
              activeRuns.requestStop(options.runId, { kind: "user_cancel", actor: "local-user",
                reason: "Isolated cancellation fixture" });
            }
          });
          cancelled = new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("Run cancelled."), { name: "AbortError" }));
            }, { once: true });
          });
        }
        process.send({ type: "ready", runId: options.runId, writeEndSeq: writeEnd?.seq,
          checkpointId: checkpoint.id, summaryRequests: this.summaryRequests });
        if (mode === "cancel") {
          await cancelled;
        } else {
          setInterval(() => {}, 1_000);
          await new Promise(() => {});
        }
      },
    });
  }

  registerCustomProviderIfNeeded(runtime, provider) {
    super.registerCustomProviderIfNeeded(runtime, provider);
    runtime.registerProvider(provider.provider, { api: "openai-completions",
      streamSimple: (model, context, options) => stream(model, context, { ...options,
        fetch: async () => {
          if (this.compacting) {
            this.summaryRequests += 1;
            return fixtureResponse({ text: "## Goal\nRead and write the marker once.\n## Progress\nPrior reads are complete.", inputTokens: 100 });
          }
          this.taskRequests += 1;
          if (this.taskRequests <= 12) {
            return fixtureResponse({ toolCallId: `crash-read-${this.taskRequests}`, name: "read",
              args: { path: join(cwd, `read-target-${this.taskRequests}.txt`) },
              inputTokens: this.summaryRequests > 0 ? 100 : 32_000 });
          }
          if (this.taskRequests === 13) {
            return fixtureResponse({ toolCallId: "crash-read-missing", name: "read",
              args: { path: join(cwd, "missing-input.txt") }, inputTokens: 100 });
          }
          if (this.taskRequests === 14) {
            return fixtureResponse({ toolCallId: "crash-write-once", name: "write",
              args: { path: join(cwd, "effect-marker.txt"), content: "COMMITTED_ONCE\n" }, inputTokens: 100 });
          }
          throw new Error("Provider request escaped the crash boundary.");
        },
      }),
    });
  }
}

const stores = new RunStoreRegistry(createSqliteRunStore);
const store = stores.getStore(cwd);
const supervisor = new RuntimeSupervisor(resolveConfig({
  defaultWorkspaceCwd: cwd,
  harness: { continuations: { mode: "enforce" } },
}));
const activeRuns = new ActiveRunRegistry();
const now = new Date().toISOString();
for (let index = 1; index <= 12; index += 1) {
  await writeFile(join(cwd, `read-target-${index}.txt`),
    `Read-only Host evidence ${index}.\n` + `fixture-${index} `.repeat(2_000), "utf8");
}
store.updateApprovalPolicy({ toolDecisions: { read: "allow", write: "allow" }, allowedWritePaths: [cwd] }, now);
const preset = store.createProviderPreset({
  kind: "openai-compatible", displayName: "Crash fixture", providerId: "host-compaction-crash-fixture",
  model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
  authHeader: false, reasoning: false, contextWindow: 32_768, maxTokens: 256,
  capabilities: ["chat", "tool_call"], enabled: true,
}, now);
store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
  title: "Crash fixture", objective: "Read inputs and write a marker exactly once." }, now);
try {
  const runId = await executeRunRequest({
    cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
    providerPresetId: preset.id, tools: ["read", "write"],
    task: { id: "host-compaction-crash", title: "Host compaction crash",
      prompt: "Read the fixture files, then write the marker. " + "goal ".repeat(100) },
    idempotencyKey: "host-compaction-crash", createdByActor: "local-user",
  }, createDetachedRunExecutionSink(),
  createRunnerRegistry([{ id: "pi", displayName: "Real Pi SDK fixture", status: "enabled",
    adapter: new CrashAtProviderBoundaryRunner() }]),
  stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});
  const completedRun = runId ? store.getRun(runId) : undefined;
  const completion = { type: mode === "cancel" ? "completed" : "unexpected_completion", runId,
    status: completedRun?.status ?? "no_run", error: completedRun?.errorMessage,
    errorCodes: runId ? store.listEvents(runId).filter(event => event.type === "run_error")
      .map(event => event.data.code) : [] };
  supervisor.releaseAll();
  stores.closeAll();
  process.send(completion);
} catch (error) {
  process.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
