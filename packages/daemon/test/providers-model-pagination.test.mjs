import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listProviderModels } from "../dist/features/providers/models.js";

const apiKey = "gemini-pagination-test-key";
const secretResolver = {
  resolve() { throw new Error("Pagination must not resolve another credential."); },
  status() { throw new Error("Pagination must not inspect another credential."); },
};

test("native Gemini discovery follows encoded page tokens on the original endpoint", async () => {
  const pageToken = "opaque /?#+=& token";
  const modelServer = await startPagedModelServer([
    { body: { models: [geminiModel("first"), geminiModel("embedding", ["embedContent"])], nextPageToken: pageToken } },
    { body: { models: [geminiModel("first"), geminiModel("second")] } },
  ]);
  try {
    const response = await discoverModels(modelServer.url);
    assert.deepEqual(response.models.map((model) => model.id), ["first", "second"]);
    assert.equal(response.source, `${modelServer.url}/models`);
    assert.equal(modelServer.requests.length, 2);
    assert.equal(modelServer.requests[0].url, "/models");
    const secondUrl = new URL(modelServer.requests[1].url, modelServer.url);
    assert.equal(secondUrl.pathname, "/models");
    assert.equal(secondUrl.searchParams.get("pageToken"), pageToken);
    assert.equal([...secondUrl.searchParams].length, 1);
    for (const request of modelServer.requests) {
      assert.equal(request.headers["x-goog-api-key"], apiKey);
    }
    assert.doesNotMatch(JSON.stringify(response), new RegExp(apiKey));
  } finally {
    await modelServer.close();
  }
});

test("native Gemini discovery continues when the first page has no generation models", async () => {
  const modelServer = await startPagedModelServer([
    { body: { models: [geminiModel("embedding", ["embedContent"])], nextPageToken: "generation-page" } },
    { body: { models: [geminiModel("second")] } },
  ]);
  try {
    const response = await discoverModels(modelServer.url);
    assert.deepEqual(response.models.map((model) => model.id), ["second"]);
    assert.equal(modelServer.requests.length, 2);
  } finally {
    await modelServer.close();
  }
});

test("native Gemini discovery rejects invalid and repeated page tokens", async () => {
  for (const pages of [
    [{ body: { models: [geminiModel("first")], nextPageToken: 42 } }],
    [
      { body: { models: [geminiModel("first")], nextPageToken: "loop" } },
      { body: { models: [geminiModel("second")], nextPageToken: "loop" } },
    ],
  ]) {
    const modelServer = await startPagedModelServer(pages);
    try {
      await assert.rejects(discoverModels(modelServer.url), (error) => error.code === "provider_error");
      assert.equal(modelServer.requests.length, pages.length);
    } finally {
      await modelServer.close();
    }
  }
});

test("native Gemini discovery does not publish a partial list when a later page fails", async () => {
  const modelServer = await startPagedModelServer([
    { body: { models: [geminiModel("first")], nextPageToken: "later" } },
    { status: 503, body: { error: `unavailable ${apiKey}` } },
  ]);
  try {
    await assert.rejects(discoverModels(modelServer.url), (error) => {
      assert.equal(error.code, "provider_error");
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      return true;
    });
    assert.equal(modelServer.requests.length, 2);
  } finally {
    await modelServer.close();
  }
});

test("native Gemini discovery stops at 200 unique models across pages", async () => {
  const modelServer = await startPagedModelServer([
    { body: { models: Array.from({ length: 199 }, (_, index) => geminiModel(`model-${index}`)), nextPageToken: "last" } },
    { body: { models: [geminiModel("model-0"), geminiModel("model-199"), geminiModel("model-200")], nextPageToken: "unused" } },
    { body: { models: [geminiModel("must-not-fetch")] } },
  ]);
  try {
    const response = await discoverModels(modelServer.url);
    assert.equal(response.models.length, 200);
    assert.equal(new Set(response.models.map((model) => model.id)).size, 200);
    assert.equal(response.models.at(-1).id, "model-199");
    assert.equal(modelServer.requests.length, 2);
  } finally {
    await modelServer.close();
  }
});

test("native Gemini discovery bounds empty pages with distinct tokens", async () => {
  const modelServer = await startPagedModelServer(Array.from({ length: 200 }, (_, index) => ({
    body: { models: [], nextPageToken: `empty-page-${index}` },
  })));
  try {
    await assert.rejects(discoverModels(modelServer.url), (error) => error.code === "provider_error");
    assert.equal(modelServer.requests.length, 200);
  } finally {
    await modelServer.close();
  }
});

test("native Gemini pages share the original ten-second abort deadline", { timeout: 15000 }, async () => {
  const modelServer = await startPagedModelServer([
    { delayMs: 3000, body: { models: [geminiModel("first")], nextPageToken: "slow" } },
    { delayMs: 8000, body: { models: [geminiModel("second")] } },
  ]);
  try {
    await assert.rejects(discoverModels(modelServer.url), (error) => error.code === "network_failed");
    assert.equal(modelServer.requests.length, 2);
  } finally {
    await modelServer.close();
  }
});

function discoverModels(baseUrl) {
  return listProviderModels({}, {
    kind: "google",
    providerId: "google-gemini",
    api: "google-generative-ai",
    baseUrl,
    apiKey,
  }, secretResolver);
}

function geminiModel(id, supportedGenerationMethods = ["generateContent"]) {
  return { name: `models/${id}`, supportedGenerationMethods };
}

async function startPagedModelServer(pages) {
  const requests = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    const page = pages[requests.length - 1];
    const send = () => {
      response.writeHead(page?.status ?? (page ? 200 : 500), { "Content-Type": "application/json" });
      response.end(JSON.stringify(page?.body ?? { error: "Unexpected extra page request." }));
    };
    if (!page?.delayMs) {
      send();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      send();
    }, page.delayMs);
    timers.add(timer);
    response.once("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      for (const timer of timers) clearTimeout(timer);
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}
