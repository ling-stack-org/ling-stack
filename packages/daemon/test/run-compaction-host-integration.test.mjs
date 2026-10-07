import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { resolveConfig } from "../dist/config.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

/** Preserve model usage and stream boundaries so Pi's real compactor sees a full turn. */
function fixtureResponse({ text, toolCallId, inputTokens = 32_000 }) {
  const delta = toolCallId
    ? { tool_calls: [{ index: 0, id: toolCallId, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: text }) } }] }
    : { content: text };
  const finishReason = toolCallId ? "tool_calls" : "stop";
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 16, total_tokens: inputTokens + 16 } },
  ];
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

test("a real Pi auto-compaction is committed as a Host checkpoint before the Run completes", { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-auto-compaction-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const supervisor = new RuntimeSupervisor(resolveConfig({
    defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" } },
  }));
  const activeRuns = new ActiveRunRegistry();
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const filePaths = Array.from({ length: 12 }, (_, index) => join(cwd, `read-target-${index + 1}.txt`));
  await Promise.all(filePaths.map((path, index) => writeFile(path,
    `Read-only Host evidence ${index + 1}.\n` + `fixture-${index + 1} `.repeat(2_000), "utf8")));
  const store = stores.getStore(cwd);
  const now = new Date().toISOString();
  const preset = store.createProviderPreset({
    kind: "openai-compatible", displayName: "Isolated compaction fixture",
    providerId: "host-auto-compaction-fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false,
    contextWindow: 32_768, maxTokens: 256, capabilities: ["chat", "tool_call"], enabled: true,
  }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: now });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "Host auto-compaction", objective: "Read the fixture and summarize it." }, now);

  class AutoCompactingRunner extends PiRunnerAdapter {
    taskRequests = 0;
    summaryRequests = 0;
    compacting = false;
    hostCompactionEnabled = false;
    contextWindows = [];
    acceptedUserPrompt = undefined;
    taskContexts = [];

    async prepareTaskInput(options) {
      return super.prepareTaskInput({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" } });
    }

    async runTask(options) {
      this.hostCompactionEnabled = options.hostCompactionEnabled === true;
      this.acceptedUserPrompt = options.preparedInput?.userPrompt;
      return super.runTask({ ...options, provider: { ...options.provider, apiKey: "fixture-no-network" },
        onEvent: (event) => {
          if (event.type === "context_compaction_start") this.compacting = true;
          if (event.type === "context_compaction_end") this.compacting = false;
          options.onEvent?.(event);
        },
      });
    }

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => {
            this.contextWindows.push(model.contextWindow);
            if (this.compacting) {
              this.summaryRequests += 1;
              return fixtureResponse({ text: "## Goal\nRead and summarize.\n## Progress\nReads are already recorded.", inputTokens: 100 });
            }
            this.taskRequests += 1;
            this.taskContexts.push({ afterCompaction: this.summaryRequests > 0, messages: structuredClone(context.messages) });
            return this.taskRequests <= filePaths.length
              ? fixtureResponse({ toolCallId: `host-auto-read-${this.taskRequests}`,
                text: filePaths[this.taskRequests - 1], inputTokens: this.summaryRequests > 0 ? 100 : 32_000 })
              : fixtureResponse({ text: "All recorded reads are complete.",
                inputTokens: this.summaryRequests > 0 ? 100 : 32_000 });
          },
        }),
      });
    }
  }

  const runner = new AutoCompactingRunner();
  const errors = [];
  const runId = await executeRunRequest({
    cwd, workspaceCwd: cwd, threadId: thread.id, teammateId: "ling_agent",
    providerPresetId: preset.id, tools: ["read"],
    task: { id: "host-auto-compaction", title: "Host auto-compaction",
      prompt: "Read the fixture before summarizing. " + "goal ".repeat(100) },
    idempotencyKey: "host-auto-compaction", createdByActor: "local-user",
  }, { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) },
  createRunnerRegistry([{ id: "pi", displayName: "Real Pi SDK fixture", status: "enabled", adapter: runner }]),
  stores, activeRuns, supervisor, { resolve: () => ({ configured: false }) }, {});

  assert.ok(runId, JSON.stringify(errors));
  assert.equal(store.getRun(runId)?.status, "succeeded", JSON.stringify({ errors,
    runError: store.getRun(runId)?.errorMessage,
    events: store.listEvents(runId).filter((event) => event.type === "run_error" || event.type.startsWith("context_compaction_")),
    taskRequests: runner.taskRequests, summaryRequests: runner.summaryRequests,
  }));
  assert.ok(runner.taskRequests >= filePaths.length + 1);
  assert.ok(runner.summaryRequests >= 1, JSON.stringify({ hostCompactionEnabled: runner.hostCompactionEnabled,
    taskRequests: runner.taskRequests,
    contextWindows: runner.contextWindows,
    compactionEvents: store.listEvents(runId).filter((event) => event.type.startsWith("context_compaction_")),
    usages: store.listEvents(runId).filter((event) => event.type === "message_end")
      .map((event) => event.data.usage),
  }));
  const events = store.listEvents(runId);
  const toolEnds = events.filter((event) => event.type === "tool_end");
  const installed = events.find((event) => event.type === "context_compaction_end"
    && event.data.outcome === "sdk_installed");
  assert.equal(toolEnds.length, filePaths.length);
  assert.ok(installed, "SDK must install a summary into this Host Run");
  assert.ok(toolEnds.some((event) => event.seq > installed.seq),
    "the same Run must keep executing real tools after compaction");
  const checkpoint = store.getLatestRunCompactionCheckpoint(runId);
  assert.equal(checkpoint?.state, "committed");
  assert.ok(checkpoint.sourceEventSeq >= toolEnds.at(-1).seq,
    "Host must seal post-compaction tool progress before the final provider request");
  const artifact = store.getArtifact(checkpoint.summaryArtifactId);
  assert.equal(artifact?.contentType, "application/vnd.ling.run-compaction-summary+json");
  assert.equal(artifact?.sealedPayload?.boundary, "run-compaction-progress");
  assert.ok(runner.acceptedUserPrompt);
  const userText = message => message.role === "user" ? typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.text).join("") : undefined;
  const postCompactionRequests = runner.taskContexts.filter(context => context.afterCompaction);
  assert.ok(postCompactionRequests.length > 0);
  for (const context of postCompactionRequests) {
    assert.equal(context.messages.filter(message => userText(message) === runner.acceptedUserPrompt).length, 1,
      "every real SDK task request after compaction must retain the exact accepted user task once");
  }
  assert.equal(artifact.sealedPayload.modelView.filter(message => userText(message) === runner.acceptedUserPrompt).length, 1,
    "Host progress seals must use the same task-constrained projection as the provider");
});
