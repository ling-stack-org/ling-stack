import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { frozenPiConversation } from "../dist/session-transcript.js";
import type { PiRunnerEvent, PiRunnerRunOptions } from "../dist/types.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-authority-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const events: PiRunnerEvent[] = [];
  let effects = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"Recovered."},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runner = new PiRunnerAdapter();
  const options: PiRunnerRunOptions = {
    cwd, agentDir: join(cwd, "agent"), runId: "saved-run", runnerAttemptId: "restored-attempt",
    task: { id: "saved-task", title: "Recover", prompt: "Report the saved read without repeating it." },
    provider: { provider: "authority-fixture", model: "fixture", api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-no-network", reasoning: false },
    tools: ["read"], onEvent: event => { events.push(event); },
    onToolBefore: () => { effects += 1; return { allowed: true }; },
    onTaskContinuationBoundary: async () => {},
  };
  const preparedInput = await runner.prepareTaskInput(options);
  const modelView = [
    { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }], timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "saved-read", name: "read", arguments: { path: "saved.txt" } }],
      api: "openai-completions", provider: options.provider.provider, model: options.provider.model, stopReason: "toolUse",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 },
    { role: "toolResult", toolCallId: "saved-read", toolName: "read", isError: false,
      content: [{ type: "text", text: "The original durable result." }], timestamp: 2 },
  ];
  return { runner, options: { ...options, preparedInput,
    ordinaryProgressRecovery: { schemaVersion: 1 as const, modelView } }, modelView, events, requests, effects: () => effects };
}

test("a restored SDK system patch preserves frozen authority without adding Host recovery effects", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let admissions = 0;
  const result = await f.runner.runTask({ ...f.options, onTaskContinuationBoundary: async point => {
    if (point !== "before_provider_request") return;
    admissions += 1;
    assert.deepEqual(f.events.map(event => event.type), ["run_start", "turn_start"],
      "only canonical recovery bookkeeping may precede the first provider request");
  } });
  assert.equal(admissions, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.effects(), 0);
  assert.ok(result.messages.filter(message => (message as { role: string }).role === "system").length >= 2,
    "the SDK transcript retains its system patch");
  const conversation = frozenPiConversation(result.messages, f.options.preparedInput);
  assert.deepEqual(conversation.slice(0, -1), f.modelView);
  assert.equal((conversation.at(-1) as { role: string }).role, "assistant");
  assert.equal(f.events.some(event => event.type === "message_end" && event.role === "system"), false);
  assert.equal(f.events.some(event => event.type === "run_end"), true);
});

const drifts: { name: string; patch: Partial<SystemMessage> }[] = [
  { name: "prompt", patch: { content: "Unsealed replacement instructions." } },
  { name: "tool declaration", patch: { toolsAdded: [{ name: "read", description: "Changed read authority", parameters: { type: "object" } }] } },
  { name: "tool removal", patch: { toolsRemoved: [{ name: "read" }] } },
];

for (const { name, patch } of drifts) {
  test(`a restored ${name} change cannot be omitted as bookkeeping or reach a provider`, { timeout: 15_000 }, async t => {
    const subscribe = AgentSession.prototype.subscribe;
    let injected = false;
    t.mock.method(AgentSession.prototype, "subscribe", function (this: AgentSession, listener: Parameters<AgentSession["subscribe"]>[0]) {
      return subscribe.call(this, event => {
        if (event.type === "message_end" && event.message.role === "system") {
          const message = { ...event.message, ...patch };
          this.agent.state.messages = this.agent.state.messages.map(value => value === event.message ? message : value);
          injected = true;
          listener({ ...event, message });
        } else listener(event);
      });
    });
    const f = await fixture(t);
    await assert.rejects(f.runner.runTask(f.options));
    assert.equal(injected, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.effects(), 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });
}
