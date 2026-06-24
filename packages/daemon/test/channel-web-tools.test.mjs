import assert from "node:assert/strict";
import test from "node:test";
import { createCompositeSecretResolver } from "../../core/dist/index.js";
import {
  buildChannelWebContext,
  extractPublicUrls,
  runOpenAiWebSearch,
  shouldReadPublicUrlsForText,
  shouldRunWebSearchForText,
} from "../dist/features/channels/web-tools.js";

test("web search trigger detects explicit and freshness search intent", () => {
  assert.equal(shouldRunWebSearchForText("搜索一下 OpenAI 今天的新闻"), true);
  assert.equal(shouldRunWebSearchForText("What is the latest Node LTS news?"), true);
  assert.equal(shouldRunWebSearchForText("现在实现这个按钮"), false);
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

test("channel web context reuses env OPENAI_API_KEY without exposing it in prompt", async () => {
  const context = await buildChannelWebContext({
    store: { getProviderPreset: () => undefined },
    sourceMessage: { body: "查一下 Ling Stack 最新消息" },
    turnEnvelope: { body: "查一下 Ling Stack 最新消息", linkPreviews: [] },
    secretResolver: createCompositeSecretResolver({ env: { OPENAI_API_KEY: "sk-test-secret-value" } }),
    fetch: async () => new Response(JSON.stringify({
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
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal(context.status, "available");
  assert.match(context.prompt, /Ling Stack result/);
  assert.match(context.prompt, /https:\/\/example\.com\/ling/);
  assert.doesNotMatch(context.prompt, /sk-test-secret-value/);
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
