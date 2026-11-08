import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { compact, generateBranchSummary, generateSummaryWithUsage, ModelRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import type { PiRunnerRunOptions } from "../dist/types.js";

const messages = [{ role: "user" as const, content: "Preserve the completed work.", timestamp: 0 }];

async function fixture({ outputLimit = 1_024, quota = 204, finishReason = "stop", finishAt = 1 } = {}) {
  const model: Model<"openai-completions"> = {
    provider: "summary-budget-fixture", id: "fixture", name: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32_768,
    maxTokens: outputLimit, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const reservations: { maxOutputTokens: number; payload: unknown }[] = [];
  const requests: { max_tokens?: number; max_completion_tokens?: number }[] = [];
  let settlements = 0;
  const options: PiRunnerRunOptions = {
    cwd: process.cwd(), task: { id: "summary-budget", title: "Summary", prompt: "Preserve the completed work." },
    runId: "summary-run", runnerAttemptId: "summary-attempt",
    provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: "fixture-no-network" },
    providerBudget: {
      requiresTokenUpperBound: true, requiresCostUpperBound: false,
      reserve(request) {
        reservations.push(request);
        if (request.maxOutputTokens > quota) throw new Error("summary quota exhausted");
        return { reservationId: `summary-${reservations.length}`, reservedTokens: 32_768 + quota };
      },
      settle() { settlements += 1; },
      settleUnknown() { assert.fail("the fixture supplies measured usage"); },
    },
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(model.provider, {
    api: model.api, apiKey: options.provider.apiKey,
    streamSimple: (requestModel, context, requestOptions) => stream(requestModel as Model<"openai-completions">, context, {
      ...requestOptions,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const records = [
          { choices: [{ index: 0, delta: { content: "Completed work retained." }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: requests.length === finishAt ? finishReason : "stop" }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 16, total_tokens: 36 } },
        ];
        return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }),
  });
  const boundary = createPiTaskBoundary(options);
  boundary.bindModelRuntime(runtime);
  const signal = boundary.options.signal;
  assert.ok(signal);
  async function admitted<T>(operation: Promise<T>): Promise<T> {
    const result = await operation;
    boundary.assertOpen();
    return result;
  }
  return { model, runtime, boundary, reservations, requests, settlements: () => settlements,
    summary: (reserveTokens = 256, previousSummary?: string) => admitted(generateSummaryWithUsage(messages, model, reserveTokens,
      options.provider.apiKey, undefined, signal, undefined, previousSummary, "off", runtime.streamSimple)),
    compact: (split = false) => admitted(compact({ firstKeptEntryId: "retained-entry", messagesToSummarize: messages,
      turnPrefixMessages: split ? messages : [], isSplitTurn: split, tokensBefore: 500,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 256, keepRecentTokens: 64 } }, model, options.provider.apiKey,
      undefined, undefined, signal, "off", runtime.streamSimple)),
    branch: () => admitted(generateBranchSummary([{ type: "message", id: "abandoned-entry", parentId: null,
      timestamp: new Date(0).toISOString(), message: messages[0] } satisfies SessionEntry], {
      model, apiKey: options.provider.apiKey, reserveTokens: 256, signal, streamFn: runtime.streamSimple,
    })),
  };
}

for (const mode of ["summary", "update", "compact", "split", "branch"] as const) {
  test(`${mode} summary reserves and sends the configured output cap`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    const result = mode === "summary" ? await f.summary()
      : mode === "update" ? await f.summary(256, "Earlier completed work.")
      : mode === "branch" ? await f.branch() : await f.compact(mode === "split");
    assert.match(("text" in result ? result.text : result.summary) ?? "", /Completed work retained\./);
    assert.equal(f.requests.length, mode === "split" ? 2 : 1);
    assert.equal(f.reservations.length, f.requests.length);
    assert.equal(f.settlements(), f.requests.length);
    for (const [index, request] of f.requests.entries()) {
      assert.equal(request.max_tokens ?? request.max_completion_tokens, 204);
      assert.equal(f.reservations[index].maxOutputTokens, 204);
      assert.deepEqual(f.reservations[index].payload, request);
    }
    f.boundary.assertOpen();
  });
}

test("the summary cap never exceeds the model output limit", async () => {
  const f = await fixture({ outputLimit: 128, quota: 128 });
  await f.summary();
  assert.equal(f.reservations[0].maxOutputTokens, 128);
  assert.equal(f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens, 128);
});

test("an insufficient summary quota still rejects before transport", async () => {
  const f = await fixture({ quota: 203 });
  await assert.rejects(f.summary(), /summary quota exhausted/);
  assert.equal(f.reservations.length, 1);
  assert.equal(f.reservations[0].maxOutputTokens, 204);
  assert.equal(f.requests.length, 0);
  assert.throws(() => f.boundary.assertOpen(), /summary quota exhausted/);
});

for (const mode of ["summary", "update", "compact", "split", "branch"] as const) {
  test(`${mode} output at the token cap cannot become a checkpoint`, async () => {
    const requestCount = mode === "split" ? 2 : 1;
    const f = await fixture({ finishReason: "length", finishAt: requestCount });
    const operation = mode === "summary" ? f.summary()
      : mode === "update" ? f.summary(256, "Earlier completed work.")
      : mode === "branch" ? f.branch() : f.compact(mode === "split");
    if (mode === "branch") {
      assert.deepEqual(await operation, {
        error: "Branch summarization failed: generation hit the token cap and the summary is incomplete",
      });
    } else {
      await assert.rejects(operation, /summary is incomplete/);
    }
    assert.equal(f.requests.length, requestCount);
    assert.equal(f.settlements(), requestCount);
    for (const request of f.requests) {
      assert.equal(request.max_tokens ?? request.max_completion_tokens, 204);
    }
  });
}
