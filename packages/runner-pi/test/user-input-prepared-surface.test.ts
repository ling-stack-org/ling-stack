import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { getCurrentTools, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiRunnerEvent, PiRunnerProviderConfig, PiRunnerRunOptions } from "../dist/types.js";
import { extensionAPI, type FixtureTool } from "./support/extension-fixture.ts";
import { FixtureRunnerBase } from "./support/provider-registration.ts";
import { createLingStackUserInputExtension } from "../dist/extensions/user-input.js";

async function fixture(t: TestContext, userInput: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-prepared-surface-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const contexts: { tools: readonly { name: string }[] }[] = [], requests: unknown[] = [];
  class FixtureRunner extends FixtureRunnerBase {
    registerCustomProviderIfNeeded(runtime: ModelRuntime, provider: PiRunnerProviderConfig) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => {
        contexts.push({ ...context, tools: getCurrentTools(context.messages).map(({ name, description, parameters, constrainedSampling }) =>
          ({ name, description, parameters, ...(constrainedSampling !== undefined ? { constrainedSampling } : {}) })) });
        return stream(model as Model<"openai-completions">, context, { ...options, fetch: async (_url, request) => {
          assert.equal(typeof request?.body, "string");
          requests.push(JSON.parse(request!.body as string));
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } });
        } });
      } });
    }
  }
  const options = { cwd, agentDir: join(cwd, "agent"), tools: [],
    task: { id: "prepared-user-input", title: "Prepared question", prompt: "Reply once." },
    provider: { provider: "question-surface-fixture", model: "fixture", api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-not-real", reasoning: false },
    initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput } } satisfies PiRunnerRunOptions;
  return { cwd, runner: new FixtureRunner(), options, contexts, requests };
}

function hasQuestionTool(tools: readonly { name: string }[]): boolean { return tools.some(tool => tool.name === "request_user_input"); }

test("enabled user input prepares the real SDK schema without a callback and binds the same execution surface", async t => {
  const f = await fixture(t, true);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.equal(hasQuestionTool(preparedInput.tools), true);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(f.cwd), []);
  let callbacks = 0;
  await f.runner.runTask({ ...f.options, preparedInput, onUserInputRequest: () => { callbacks++; throw new Error("Unexpected question"); } });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
  assert.equal(callbacks, 0);
});

test("explicitly disabled user input wins over a bound callback in both preparation and execution", async t => {
  const f = await fixture(t, false);
  let callbacks = 0;
  const options = { ...f.options, onUserInputRequest: () => { callbacks++; throw new Error("Disabled question"); } };
  const preparedInput = await f.runner.prepareTaskInput(options);
  assert.equal(hasQuestionTool(preparedInput.tools), false);
  await f.runner.runTask({ ...options, preparedInput });
  assert.equal(hasQuestionTool(f.contexts[0].tools), false);
  assert.equal(f.requests.length, 1);
  assert.equal(callbacks, 0);
});

test("changing the prepared user input surface still fails before provider transport", async t => {
  const f = await fixture(t, true);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.equal(hasQuestionTool(preparedInput.tools), true);
  await assert.rejects(f.runner.runTask({ ...f.options, preparedInput,
    initialToolSurface: { ...f.options.initialToolSurface, userInput: false } }), /prepared input changed/i);
  assert.equal(f.requests.length, 0);
});

test("enabled execution without a Host handler fails before SDK initialization, events or provider transport", async t => {
  const f = await fixture(t, true);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const events: PiRunnerEvent[] = [];
  await assert.rejects(f.runner.runTask({ ...f.options, preparedInput, onEvent: event => events.push(event) }),
    error => error instanceof Error && error.message === "user_input_host_handler_missing");
  assert.equal(f.contexts.length, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("schema-only user input cannot execute without a live Host handler", async t => {
  const f = await fixture(t, true);
  const tools: FixtureTool[] = [];
  createLingStackUserInputExtension(f.options)(extensionAPI(tools));
  assert.equal(tools.length, 1);
  await assert.rejects(tools[0].execute("call-1", { schemaVersion: 1, waitMode: "required", questions: [] }),
    error => error instanceof Error && error.message === "user_input_host_handler_missing");
  assert.equal(f.requests.length, 0);
});
