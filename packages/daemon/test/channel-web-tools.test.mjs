import assert from "node:assert/strict";
import test from "node:test";
import { createCompositeSecretResolver } from "../../core/dist/index.js";
import {
  buildChannelWebContext,
  extractPublicUrls,
  planWebSearchQueries,
  runGoogleInteractionsWebSearch,
  runOpenAiChatCompletionsWebSearch,
  runOpenAiWebSearch,
  shouldReadPublicUrlsForText,
  shouldRunWebSearchForText,
} from "../dist/features/channels/web-tools.js";

test("web search trigger detects explicit and freshness search intent", () => {
  assert.equal(shouldRunWebSearchForText("搜索一下 OpenAI 今天的新闻"), true);
  assert.equal(shouldRunWebSearchForText("What is the latest Node LTS news?"), true);
  assert.equal(shouldRunWebSearchForText("现在实现这个按钮"), false);
});

test("web search query planner expands freshness intent", () => {
  const queries = planWebSearchQueries("查一下今天热门 AI 的新闻");
  assert.equal(queries[0], "查一下今天热门 AI 的新闻");
  assert.ok(queries.length > 1);
  assert.ok(queries.includes("AI news today") || queries.includes("latest AI news"));
});

test("public URL intent extracts bounded HTTP URLs", () => {
  assert.equal(shouldReadPublicUrlsForText("读一下 https://example.com/a?b=1。"), true);
  assert.deepEqual(extractPublicUrls("open https://example.com/a, then https://example.com/a"), ["https://example.com/a"]);
});

test("OpenAI web search uses Responses web_search and extracts citations", async () => {
  const calls = [];
  const result = await runOpenAiWebSearch({
    endpoint: "https://api.openai.test/v1/responses",
    apiKey: "sk-test-secret-value",
    model: "gpt-5.5",
    query: "latest product news",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Search summary with a citation.",
        output: [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [
                { type: "url", url: "https://example.com/source", title: "Source title", snippet: "Source snippet" },
              ],
            },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Search summary with a citation.",
                annotations: [
                  { type: "url_citation", url: "https://example.com/cited", title: "Cited title" },
                ],
              },
            ],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.openai.test/v1/responses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-secret-value");
  assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  assert.equal(result.text, "Search summary with a citation.");
  assert.deepEqual(result.sources.map((source) => source.url), [
    "https://example.com/source",
    "https://example.com/cited",
  ]);
});

test("Responses-compatible web search uses explicit compat protocol for relays", async () => {
  const calls = [];
  const context = await buildChannelWebContext({
    providerPresetId: "provider_xai_web",
    store: { getProviderPreset: () => createResponsesCompatibleWebSearchProvider() },
    sourceMessage: { body: "搜索一下 Grok 今天的新闻" },
    turnEnvelope: { body: "搜索一下 Grok 今天的新闻", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { XAI_API_KEY: "sk-test-xai-secret" } }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Grok search result.",
        citations: ["https://example.com/grok"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-xai-secret");
  assert.equal(context.status, "available");
  assert.equal(context.search?.provider.adapterId, "openai-responses-web-search");
  assert.deepEqual(context.search?.sources.map((source) => source.url), ["https://example.com/grok"]);
});

test("channel web context uses global web_search backend independent from chat provider", async () => {
  const calls = [];
  const chatProvider = {
    ...createOpenAiWebSearchProvider(),
    id: "provider_chat_only",
    displayName: "Chat Only Relay",
    kind: "openai-compatible",
    providerId: "chat-only",
    api: "openai-completions",
    baseUrl: "https://chat.example.test/v1",
    capabilities: ["chat", "tool_call", "reasoning"],
    compat: {},
  };
  const webProvider = createResponsesCompatibleWebSearchProvider();
  const context = await buildChannelWebContext({
    providerPresetId: chatProvider.id,
    store: {
      getProviderPreset: (providerId) => providerId === chatProvider.id ? chatProvider : webProvider,
      listProviderPresets: () => [chatProvider, webProvider],
    },
    sourceMessage: { body: "查一下今天的 AI 新闻" },
    turnEnvelope: { body: "查一下今天的 AI 新闻", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { XAI_API_KEY: "sk-test-xai-secret" } }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Global backend result.",
        citations: ["https://example.com/global-web"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(context.status, "available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/responses");
  assert.equal(context.search?.provider.providerPresetId, webProvider.id);
  assert.match(context.prompt, /Global backend result/);
});

test("channel web context degrades search summaries without source URLs", async () => {
  const calls = [];
  const webProvider = {
    ...createResponsesCompatibleWebSearchProvider(),
    id: "provider_chat_completions_search",
    displayName: "Chat Completions Search Relay",
    api: "openai-completions",
    baseUrl: "https://relay.example.test/v1",
    apiKeyRef: "env:RELAY_API_KEY",
    compat: { webSearch: { protocol: "openai-chat-completions-search" } },
  };
  const context = await buildChannelWebContext({
    providerPresetId: webProvider.id,
    store: {
      getProviderPreset: () => webProvider,
      listProviderPresets: () => [webProvider],
    },
    sourceMessage: { body: "查一下今天热门 AI 的新闻" },
    turnEnvelope: { body: "查一下今天热门 AI 的新闻", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { RELAY_API_KEY: "sk-test-relay-secret" } }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "Relay returned a summary without citations.",
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 4);
  assert.equal(context.status, "degraded");
  assert.equal(context.search?.sources.length, 0);
  assert.ok(context.search?.queries && context.search.queries.length > 1);
  assert.match(context.reason ?? "", /no source URLs/);
  assert.match(context.prompt ?? "", /Web search status: degraded/);
  assert.match(context.prompt ?? "", /Search queries:/);
  assert.doesNotMatch(context.prompt ?? "", /sk-test-relay-secret/);
});

test("channel web context resolves local provider secrets for global web_search backend", async () => {
  const webProvider = {
    ...createResponsesCompatibleWebSearchProvider(),
    id: "provider_local_web",
    apiKeyRef: "local:provider_local_web",
  };
  const calls = [];
  const context = await buildChannelWebContext({
    providerPresetId: "provider_chat_only",
    store: {
      getProviderPreset: (providerId) => providerId === webProvider.id ? webProvider : ({
        ...createOpenAiWebSearchProvider(),
        id: "provider_chat_only",
        capabilities: ["chat"],
        compat: {},
      }),
      listProviderPresets: () => [webProvider],
      hasProviderSecret: (providerId) => providerId === webProvider.id,
      getProviderSecret: (providerId) => providerId === webProvider.id ? "sk-local-web-secret" : undefined,
    },
    sourceMessage: { body: "查一下今天的 AI 新闻" },
    turnEnvelope: { body: "查一下今天的 AI 新闻", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: {} }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Local secret web result.",
        citations: ["https://example.com/local-secret"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(context.status, "available");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-local-web-secret");
  assert.doesNotMatch(context.prompt, /sk-local-web-secret/);
});

test("channel web context honors provider web search timeout override", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutCalls = [];
  AbortSignal.timeout = (timeoutMs) => {
    timeoutCalls.push(timeoutMs);
    return originalTimeout(60_000);
  };
  try {
    const chatProvider = {
      ...createOpenAiWebSearchProvider(),
      id: "provider_chat_only",
      displayName: "Chat Only Relay",
      kind: "openai-compatible",
      providerId: "chat-only",
      api: "openai-completions",
      baseUrl: "https://chat.example.test/v1",
      capabilities: ["chat", "tool_call", "reasoning"],
      compat: {},
    };
    const webProvider = {
      ...createResponsesCompatibleWebSearchProvider(),
      id: "provider_slow_web",
      compat: { webSearch: { protocol: "responses-web-search", timeoutMs: 45_000 } },
    };
    const context = await buildChannelWebContext({
      providerPresetId: chatProvider.id,
      store: {
        getProviderPreset: (providerId) => providerId === chatProvider.id ? chatProvider : webProvider,
        listProviderPresets: () => [chatProvider, webProvider],
      },
      sourceMessage: { body: "搜索一下慢速 relay 今天的新闻" },
      turnEnvelope: { body: "搜索一下慢速 relay 今天的新闻", linkPreviews: [] },
      secretResolver: createCompositeSecretResolver({ env: { XAI_API_KEY: "sk-test-xai-secret" } }),
      fetch: async () => new Response(JSON.stringify({
        output_text: "Slow relay search result.",
        citations: ["https://example.com/slow"],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    assert.equal(context.status, "available");
    assert.equal(context.search?.provider.providerPresetId, webProvider.id);
    assert.ok(timeoutCalls.includes(45_000));
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("Chat Completions web search protocol uses web_search_options and extracts citations", async () => {
  const calls = [];
  const result = await runOpenAiChatCompletionsWebSearch({
    endpoint: "https://relay.example.test/v1/chat/completions",
    apiKey: "sk-test-secret-value",
    model: "search-model",
    query: "latest product news",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "Chat search summary.",
              annotations: [
                { type: "url_citation", url_citation: { url: "https://example.com/chat-search", title: "Chat source" } },
              ],
            },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://relay.example.test/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-secret-value");
  assert.deepEqual(body.messages, [{ role: "user", content: "latest product news" }]);
  assert.deepEqual(body.web_search_options, { search_context_size: "low" });
  assert.equal(result.text, "Chat search summary.");
  assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/chat-search"]);
});

test("Gemini web search protocol uses Google Search grounding and extracts sources", async () => {
  const calls = [];
  const result = await runGoogleInteractionsWebSearch({
    endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
    apiKey: "gemini-secret-value",
    model: "models/gemini-3.5-flash",
    query: "latest product news",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        steps: [
          {
            type: "model_output",
            content: [
              {
                text: "Gemini grounded summary.",
                annotations: [
                  { type: "url_citation", url: "https://example.com/gemini", title: "Gemini source" },
                ],
              },
            ],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "gemini-secret-value");
  assert.equal(body.model, "gemini-3.5-flash");
  assert.equal(body.input, "latest product news");
  assert.deepEqual(body.tools, [{ type: "google_search" }]);
  assert.equal(result.text, "Gemini grounded summary.");
  assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/gemini"]);
});

test("channel web context uses selected web_search provider key without exposing it in prompt", async () => {
  const calls = [];
  const context = await buildChannelWebContext({
    providerPresetId: "provider_openai_web",
    store: { getProviderPreset: () => createOpenAiWebSearchProvider() },
    sourceMessage: { body: "查一下 Ling Stack 最新消息" },
    turnEnvelope: { body: "查一下 Ling Stack 最新消息", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output_text: "Ling Stack result.",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Ling Stack result.",
                annotations: [
                  { type: "url_citation", url: "https://example.com/ling", title: "Ling source" },
                ],
              },
            ],
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-secret-value");
  assert.equal(context.status, "available");
  assert.match(context.prompt, /Ling Stack result/);
  assert.match(context.prompt, /https:\/\/example\.com\/ling/);
  assert.doesNotMatch(context.prompt, /sk-test-secret-value/);
});

test("channel web context does not bypass provider settings with env OPENAI_API_KEY", async () => {
  let fetched = false;
  const chatProvider = {
    ...createOpenAiWebSearchProvider(),
    id: "provider_chat_only",
    capabilities: ["chat", "tool_call", "reasoning"],
    compat: {},
  };
  const context = await buildChannelWebContext({
    providerPresetId: chatProvider.id,
    store: {
      getProviderPreset: () => chatProvider,
      listProviderPresets: () => [chatProvider],
    },
    sourceMessage: { body: "查一下 Ling Stack 最新消息" },
    turnEnvelope: { body: "查一下 Ling Stack 最新消息", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    fetch: async () => {
      fetched = true;
      return new Response("should not fetch", { status: 200 });
    },
  });

  assert.equal(fetched, false);
  assert.equal(context.status, "blocked");
  assert.match(context.prompt, /No Ling global web_search backend is configured/);
  assert.match(context.prompt, /will not bypass model settings/);
  assert.doesNotMatch(context.prompt, /sk-test-secret-value/);
});

test("channel web context blocks declared web_search providers without an adapter", async () => {
  let fetched = false;
  const context = await buildChannelWebContext({
    providerPresetId: "provider_compatible_web",
    store: {
      getProviderPreset: () => ({
        ...createOpenAiWebSearchProvider(),
        id: "provider_compatible_web",
        kind: "openai-compatible",
        displayName: "Compatible Relay With Search Claim",
        providerId: "compatible-relay",
        api: "openai-completions",
        baseUrl: "https://relay.example.test/v1",
      }),
    },
    sourceMessage: { body: "查一下 Ling Stack 最新消息" },
    turnEnvelope: { body: "查一下 Ling Stack 最新消息", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    fetch: async () => {
      fetched = true;
      return new Response("should not fetch", { status: 200 });
    },
  });

  assert.equal(fetched, false);
  assert.equal(context.status, "blocked");
  assert.match(context.prompt, /do not have a matching web-search adapter protocol/);
});

test("OpenAI web search redacts masked API keys from provider errors", async () => {
  await assert.rejects(
    runOpenAiWebSearch({
      endpoint: "https://api.openai.test/v1/responses",
      apiKey: "sk-test-secret-value",
      model: "gpt-5.5",
      query: "latest product news",
      fetch: async () => new Response(JSON.stringify({
        error: {
          message: "Incorrect API key provided: sk-pulsa*************-001.",
        },
      }), { status: 401, headers: { "content-type": "application/json" } }),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Incorrect API key provided: \[redacted\]/);
      assert.doesNotMatch(error.message, /sk-pulsa/);
      return true;
    },
  );
});

test("channel read URL context blocks localhost without fetching", async () => {
  let fetched = false;
  const context = await buildChannelWebContext({
    store: { getProviderPreset: () => undefined },
    sourceMessage: { body: "读一下 http://localhost:17891/health" },
    turnEnvelope: { body: "读一下 http://localhost:17891/health", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: {} }),
    fetch: async () => {
      fetched = true;
      return new Response("should not fetch", { status: 200 });
    },
  });

  assert.equal(fetched, false);
  assert.equal(context.status, "blocked");
  assert.match(context.prompt, /local or private network targets/i);
});

function createOpenAiWebSearchProvider() {
  return {
    id: "provider_openai_web",
    kind: "openai",
    displayName: "OpenAI Responses + Web Search",
    providerId: "openai",
    model: "gpt-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "env:OPENAI_API_KEY",
    headers: {},
    input: ["text"],
    compat: {},
    capabilities: ["chat", "tool_call", "reasoning", "web_search"],
    enabled: true,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

function createResponsesCompatibleWebSearchProvider() {
  return {
    ...createOpenAiWebSearchProvider(),
    id: "provider_xai_web",
    kind: "openai-compatible",
    displayName: "Grok Responses + Web Search",
    providerId: "xai",
    model: "grok-4.3",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    apiKeyRef: "env:XAI_API_KEY",
    compat: { webSearch: { protocol: "responses-web-search" } },
  };
}
