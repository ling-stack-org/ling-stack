import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export function response({ text = "Fixture complete.", toolCallId, inputTokens = 100 } = {}) {
  const delta = toolCallId ? { tool_calls: [{ index: 0, id: toolCallId, type: "function",
    function: { name: "fixture_effect", arguments: "{}" } }] } : { content: text };
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCallId ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 16, total_tokens: inputTokens + 16 } },
  ];
  return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Real SDK session/parser/compactor; isolated transport, credentials, resources and temporary effects. */
export async function compactionFixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-compaction-"));
  const effectPath = join(cwd, "effects.txt");
  const events = [], requests = [], holds = [];
  let session, compacting = false;
  t.after(async () => {
    for (const hold of holds) hold.resolve();
    if (session) { session.abortCompaction(); await session.abort(); session.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null });
  const provider = "ling-compaction-fixture";
  await modelRuntime.setRuntimeApiKey(provider, "fixture-no-network");
  modelRuntime.registerProvider(provider, {
    name: provider, baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-no-network",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 2_000,
      maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  modelRuntime.registerProvider(provider, {
    api: "openai-completions",
    streamSimple: (model, context, streamOptions) => stream(model, context, {
      ...streamOptions,
      fetch: async () => {
        const phase = compacting ? "summary" : "task";
        const request = { phase, index: requests.filter(item => item.phase === phase).length,
          messages: structuredClone(context.messages), signal: streamOptions?.signal };
        requests.push(request);
        return phase === "summary"
          ? (options.summary?.(request) ?? response({ text: "## Goal\nPreserve the fixture goal.\n## Progress\nEffects are already recorded; do not repeat them." }))
          : (options.task?.(request) ?? response());
      },
    }),
  });
  options.bindRuntime?.(modelRuntime);
  const extensionRuntime = createExtensionRuntime();
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are an isolated lifecycle fixture. Use only fixture_effect.",
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  const sessionManager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 64, ...options.compaction },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, provider: { maxRetries: 0 }, ...options.retry },
  });
  ({ session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime,
    model: modelRuntime.getModel(provider, "fixture"), thinkingLevel: "off", resourceLoader,
    sessionManager, settingsManager, tools: ["fixture_effect"], customTools: [{
      name: "fixture_effect", label: "Fixture effect", description: "Append an isolated test marker once.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(toolCallId, _params, signal) {
        await appendFile(effectPath, toolCallId + "\n", "utf8");
        return options.tool?.({ toolCallId, signal }) ?? { content: [{ type: "text", text: "Recorded " + toolCallId + " " + "x".repeat(600) }], details: {} };
      },
    }],
  }));
  session.subscribe(event => {
    events.push(event);
    if (event.type === "compaction_start") compacting = true;
    if (event.type === "compaction_end") compacting = false;
    options.event?.(event);
  });
  return { session, sessionManager, settingsManager, events, requests,
    hold() {
      let resolve;
      const promise = new Promise(accept => { resolve = accept; });
      const hold = { promise, resolve }; holds.push(hold); return hold;
    },
    async effects() {
      try { return (await readFile(effectPath, "utf8")).trim().split("\n").filter(Boolean); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}
