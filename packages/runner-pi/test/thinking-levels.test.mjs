import assert from "node:assert/strict";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRunnerAdapter } from "../dist/adapter.js";

for (const api of ["openai-completions", "openai-responses", "openai-codex-responses"]) {
  test(`${api} sends distinct max and ultra efforts after prepared-input replay`, { timeout: 15_000 }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-thinking-levels-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      requests.push(JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (api === "openai-completions") {
        response.end('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else {
        const message = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Done", annotations: [] }] };
        const events = [
          { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done" },
          { type: "response.output_item.done", output_index: 0, item: message },
          { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [message],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
        ];
        response.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const provider = { provider: "thinking-fixture", model: "fixture", api, apiKey: `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`, providerTransport: "sse",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: true,
      thinkingLevelMap: { high: "high", xhigh: "xhigh", max: "max", ultra: "ultra" },
      compat: { supportsReasoningEffort: true } };
    const runner = new PiRunnerAdapter();
    for (const thinkingLevel of ["max", "ultra", "max"]) {
      const options = { cwd, agentDir: join(cwd, "agent"), tools: [], provider, thinkingLevel,
        task: { id: "thinking-levels", title: "Test", prompt: "Reply Done" } };
      const preparedInput = await runner.prepareTaskInput(options);
      await runner.runTask({ ...options, preparedInput });
      const body = requests.at(-1);
      assert.equal(api === "openai-completions" ? body.reasoning_effort : body.reasoning?.effort, thinkingLevel);
      assert.equal(provider.thinkingLevelMap.max, "max", "ultra must not mutate later max requests");
    }
    assert.equal(requests.length, 3);
    for (const thinkingLevel of ["max", "ultra"]) {
      await assert.rejects(runner.prepareTaskInput({ cwd, provider: { ...provider, thinkingLevelMap: {} },
        thinkingLevel, tools: [], task: { id: "unsupported", title: "Test", prompt: "Test" } }), /does not declare reasoning level/);
      if (api === "openai-completions") {
        await assert.rejects(runner.prepareTaskInput({ cwd,
          provider: { ...provider, compat: { supportsReasoningEffort: false } }, thinkingLevel, tools: [],
          task: { id: "disabled", title: "Test", prompt: "Test" } }), /disables reasoning_effort/);
      }
    }
    assert.equal(requests.length, 3, "unsupported levels must fail before HTTP dispatch");
    if (api === "openai-completions") {
      for (const thinkingFormat of ["qwen-chat-template", "chat-template"]) {
        await assert.rejects(runner.prepareTaskInput({ cwd, tools: [], thinkingLevel: "max",
          provider: { ...provider, compat: { thinkingFormat } },
          task: { id: "format", title: "Test", prompt: "Test" } }), /adapter configuration/);
      }
      // These provider defaults normally suppress reasoning_effort. Explicit model
      // capability metadata must take precedence without changing other sessions.
      for (const thinkingLevel of ["max", "ultra"]) {
        const options = { cwd, tools: [], provider: { ...provider, provider: "zai", compat: undefined }, thinkingLevel,
          task: { id: "compat", title: "Test", prompt: "Done" } };
        const preparedInput = await runner.prepareTaskInput(options);
        await runner.runTask({ ...options, preparedInput });
        assert.equal(requests.at(-1).reasoning_effort, thinkingLevel);
      }
    }
  });
}

test("declared efforts override a built-in model's older map without mutating it", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-thinking-builtin-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = new PiRunnerAdapter();
  const provider = { provider: "openai", model: "gpt-5.5", api: "openai-responses", reasoning: true,
    thinkingLevelMap: { max: "max", ultra: "ultra" } };
  for (const thinkingLevel of ["max", "ultra", "max"]) {
    const prepared = await runner.prepareTaskInput({ cwd, provider, thinkingLevel, tools: [],
      task: { id: "builtin", title: "Test", prompt: "Test" } });
    assert.equal(prepared.thinkingLevel, "max");
    assert.equal(prepared.model.thinkingLevelMap.max, thinkingLevel);
  }
});

test("budget-only adapters reject top levels instead of sending a lower budget", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-thinking-budget-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = new PiRunnerAdapter();
  for (const thinkingLevel of ["max", "ultra"]) {
    await assert.rejects(runner.prepareTaskInput({ cwd, tools: [], thinkingLevel,
      provider: { provider: "anthropic-relay", model: "claude-opus-4-8", api: "anthropic-messages",
        baseUrl: "http://127.0.0.1:1", reasoning: true, thinkingLevelMap: { max: "max", ultra: "ultra" } },
      task: { id: "budget", title: "Test", prompt: "Test" } }), /not supported by the anthropic-messages adapter configuration/);
  }
  const prepared = await runner.prepareTaskInput({ cwd, tools: [], thinkingLevel: "max",
    provider: { provider: "anthropic", model: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { max: "max" } },
    task: { id: "adaptive", title: "Test", prompt: "Test" } });
  assert.equal(prepared.thinkingLevel, "max");
  assert.equal(prepared.model.compat.forceAdaptiveThinking, true);
});
