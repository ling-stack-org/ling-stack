import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { PiRunnerAdapter } from "../../../runner-pi/dist/index.js";
import { stream } from "../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";

// Exercise the actual SDK's sealed boundary observation without a provider call.
export class ToolFreePiRunner extends PiRunnerAdapter {
  replies = new AsyncLocalStorage();
  fixtureUsage;

  async runTask(options, reply = () => "Controlled tool-free reply.") {
    let response, failure, failed = false;
    // SDK transport retries belong to one scripted execution, not another Run.
    const once = () => response ??= Promise.resolve().then(reply).catch(error => {
      failed = true; failure = error; throw error;
    });
    try { return await this.replies.run(once, () => super.runTask(options)); }
    catch (error) { throw failed && !options.signal?.aborted ? failure : error; }
  }

  registerCustomProviderIfNeeded(runtime, provider) {
    super.registerCustomProviderIfNeeded(runtime, { ...provider, baseUrl: provider.baseUrl ?? "https://fixture.invalid/v1" });
    const reply = this.replies.getStore() ?? (() => "Controlled tool-free reply.");
    runtime.registerProvider(provider.provider, { api: provider.api ?? "openai-completions", apiKey: "fixture-no-network",
      streamSimple: (model, context, options) => stream(model, context, { ...options,
        fetch: async () => {
          const text = await reply();
          assert.equal(typeof text, "string");
          const usage = this.fixtureUsage;
          return new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
            + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
            + (usage ? `data: ${JSON.stringify({ choices: [], usage: {
              prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            } })}\n\n` : "") + 'data: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } });
        },
      }),
    });
  }
}
