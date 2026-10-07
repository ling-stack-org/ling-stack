import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { response } from "./support/pi-compaction-fixture.mjs";

const privateDetail = "PRIVATE_PROVIDER_BODY sk-fixture-secret /private/model-view";

for (const outcome of ["succeeded", "failed", "cancelled"]) {
  test(`real adapter provider retry ${outcome} preserves tools and terminal authority`, { timeout: 15_000 }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-pi-provider-retry-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const events = [], effects = [];
    const controller = new AbortController();
    let requests = 0;
    class FixtureRunner extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions",
          streamSimple: (model, context, options) => stream(model, context, { ...options, maxRetries: 0,
            fetch: async () => {
              requests += 1;
              if (requests === 1) return response({ toolCallId: "completed-effect", inputTokens: 100 });
              if (requests === 3 && outcome === "succeeded") return response({ text: "Complete.", inputTokens: 100 });
              return new Response(JSON.stringify({ error: { message: privateDetail } }),
                { status: 503, headers: { "content-type": "application/json" } });
            },
          }),
        });
      }
    }
    const pending = new FixtureRunner().runTask({ cwd, agentDir: join(cwd, "agent"), tools: [],
      task: { id: "provider-retry-adapter", title: "Isolated retry", prompt: "Finish without repeating effects." },
      provider: { provider: "provider-retry-adapter", model: "fixture", baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions", apiKey: "fixture-no-network", reasoning: false },
      signal: controller.signal,
      mcpTools: [{ registeredName: "fixture_effect", serverId: "fixture", rawName: "fixture_effect",
        displayName: "Fixture effect", inputSchema: { type: "object", properties: {} },
        sideEffectLevel: "read", defaultApproval: "allow" }],
      onMcpToolCall: async request => { effects.push(request.toolCallId); return { content: [{ type: "text", text: "Recorded." }] }; },
      onEvent: event => {
        events.push(event);
        if (outcome === "cancelled" && event.type === "provider_retry" && event.phase === "scheduled") controller.abort();
      },
    });
    if (outcome === "succeeded") await pending;
    else if (outcome === "cancelled") await assert.rejects(pending, { name: "AbortError" });
    else await assert.rejects(pending, /Provider message ended with an error/);
    assert.deepEqual(effects, ["completed-effect"]);
    assert.equal(requests, outcome === "cancelled" ? 2 : 3);
    assert.equal(events.filter(event => event.type === "run_end").length, outcome === "succeeded" ? 1 : 0);
    assert.equal(events.filter(event => event.type === "run_error").length, outcome === "succeeded" ? 0 : 1);
    if (outcome === "failed") {
      assert.equal(events.at(-1).type, "run_error");
      assert.equal(events.at(-1).errorDiagnostic?.category, "provider_unavailable");
      assert.equal(events.at(-1).errorDiagnostic?.httpStatus, 503);
    }
    if (outcome === "cancelled") assert.equal(events.at(-1).errorDiagnostic, undefined,
      "user cancellation must not borrow the earlier provider diagnosis");
    assert.equal(JSON.stringify(events).includes(privateDetail), false);
  });
}
