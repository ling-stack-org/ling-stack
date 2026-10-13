import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium } from "@playwright/test";

// Explicit browser regression, not part of the browser-free test:ci glob:
// node --test test/provider-editor-discovery.browser.mjs
// Uses the actual Hook, ReactDOM and request payload adapter with synthetic
// credentials and deferred in-memory responses. No provider or daemon is used.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const controllerPath = fileURLToPath(new URL("../src/features/providers/useProviderEditorController.ts", import.meta.url));
const providerApiPath = fileURLToPath(new URL("../src/api/providers.ts", import.meta.url));
// Optional read-only historical source alias proves regressions without replacing WIP.
const controllerBaseline = process.env.LING_WEB_TEST_CONTROLLER_BASELINE;
const baselineSource = controllerBaseline ? execFileSync("git", ["show", `${controllerBaseline}:apps/web/src/features/providers/useProviderEditorController.ts`], {
  cwd: webRoot, encoding: "utf8",
}) : undefined;
const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = desktopRequire("esbuild");
let browser, server, baseUrl;

const form = {
  kind: "openai-compatible", displayName: "Fixture", providerId: "fixture-provider", model: "fixture-model",
  api: "openai-completions", providerTransport: "", baseUrl: "https://fixture.invalid/v1", apiKey: "FIXTURE_KEY_A",
  apiKeyRef: "local:fixture-a", clearApiKey: false, secretHeaderRefsText: "X-Fixture: env:FIXTURE_A",
  capabilitiesText: "chat, tool_call", inputText: "text", enabled: true, authHeader: true, reasoning: false,
  thinkingModes: [], contextWindow: "", maxTokens: "",
};
const scope = { cwd: "/fixture-a", editingProviderId: "preset-a", form };
function response(id, overrides = {}) {
  return { source: "fixture:discovery", fetchedAt: "2026-10-09T00:00:00.000Z", catalog: { status: "available" },
    models: [{ id, capabilities: ["chat"] }], ...overrides };
}

before(async () => {
  const built = await build({
    stdin: { contents: harnessSource(), resolveDir: webRoot, sourcefile: "provider-editor-browser-fixture.tsx", loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false, logLevel: "silent",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "provider-editor-fixture-api", setup(plugin) {
      if (baselineSource !== undefined) plugin.onLoad({ filter: /useProviderEditorController\.ts$/ }, args => args.path === controllerPath
        ? { contents: baselineSource, resolveDir: fileURLToPath(new URL("../src/features/providers", import.meta.url)), loader: "ts" } : undefined);
      plugin.onResolve({ filter: /^\.\.\/\.\.\/api\.js$/ }, args => args.importer === controllerPath
        ? { path: "fixture-api", namespace: "fixture" } : undefined);
      plugin.onResolve({ filter: /^\.\.\/\.\.\/i18n\.js$/ }, args => args.importer === controllerPath
        ? { path: "fixture-i18n", namespace: "fixture" } : undefined);
      plugin.onResolve({ filter: /^\.\/client\.js$/ }, args => args.importer === providerApiPath
        ? { path: "fixture-client", namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path === "fixture-api" ? `export { listProviderModels } from ${JSON.stringify(providerApiPath)};`
          : args.path === "fixture-client" ? "export const daemonClient = { listProviderModels: (...args) => window.qa.request(...args) };"
            : "const t = value => value; export const useI18n = () => ({ t });",
        resolveDir: webRoot, loader: "js",
      }));
    } }],
  });
  server = createServer((_request, result) => {
    result.setHeader("Content-Type", "text/html; charset=utf-8");
    result.end(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE
    ? { headless: true, executablePath: process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE }
    : { headless: true, channel: "chrome" });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function withPage(run) {
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl);
    await page.evaluate(input => window.qa.mount(input), scope);
    await page.evaluate(() => window.qa.flushEffects());
    await run(page);
  } finally { await page.close(); }
}

const changedScopes = [
  ["workspace", { cwd: "/fixture-b" }],
  ["editing preset", { editingProviderId: "preset-b" }],
  ["provider kind", { form: { kind: "openai" } }],
  ["transport", { form: { providerTransport: "http" } }],
  ["API key reference", { form: { apiKeyRef: "local:fixture-b" } }],
  ["secret Header references", { form: { secretHeaderRefsText: "X-Fixture: env:FIXTURE_B" } }],
  ["auth Header", { form: { authHeader: false } }],
  ["provider identity", { form: { providerId: "fixture-provider-b" } }],
  ["API", { form: { api: "openai-responses" } }],
  ["endpoint", { form: { baseUrl: "https://fixture-b.invalid/v1" } }],
  ["inline credential", { form: { apiKey: "FIXTURE_KEY_B" } }],
];
for (const [name, change] of changedScopes) {
  test(`real Hook suppresses late success, error and loading state after ${name} changes`, () => withPage(async page => {
    for (const outcome of ["resolve", "reject"]) {
      await page.evaluate(input => window.qa.mount(input), scope);
      await page.evaluate(() => window.qa.flushEffects());
      await page.evaluate(() => window.qa.fetch());
      const index = await page.evaluate(() => window.qa.requestCount() - 1);
      await page.evaluate(input => window.qa.change(input), change);
      await page.evaluate(() => window.qa.flushEffects());
      await page.evaluate(({ index, outcome, result }) => window.qa.finish(index, outcome, result), { index, outcome, result: response("obsolete") });
      const snapshot = await page.evaluate(() => window.qa.snapshot());
      assert.deepEqual(snapshot.models, []);
      assert.equal(snapshot.source, "");
      assert.equal(snapshot.error, "");
      assert.equal(snapshot.fetching, false);
      assert.equal(snapshot.selectedImportCount, 0);
    }
  }));
}

test("changed scope hides already loaded rows in the render before passive reset effects", () => withPage(async page => {
  await page.evaluate(() => window.qa.fetch());
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("old"));
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["old"]);
  await page.evaluate(() => window.qa.clearRenders());
  await page.evaluate(() => window.qa.change({ cwd: "/fixture-b" }));
  const renders = await page.evaluate(() => window.qa.renders());
  assert.ok(renders.length > 0);
  assert.deepEqual(renders[0].models, [], "the first render cannot expose prior-workspace models");
  assert.equal(renders[0].source, "");
  assert.equal(renders[0].selectedImportCount, 0);
}));

test("latest request wins; an older finalizer never clears the current pending flag", () => withPage(async page => {
  await page.evaluate(() => { window.qa.fetch(); window.qa.fetch(); });
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("older"));
  assert.equal((await page.evaluate(() => window.qa.snapshot())).fetching, true);
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, []);
  await page.evaluate(result => window.qa.finish(1, "resolve", result), response("newer"));
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["newer"]);
  assert.equal((await page.evaluate(() => window.qa.snapshot())).fetching, false);
}));

test("a saved old-render fetch callback cannot claim the current scope or supersede its pending request", () => withPage(async page => {
  await page.evaluate(() => window.qa.captureFetch());
  await page.evaluate(() => window.qa.change({ cwd: "/fixture-b", form: { apiKey: "FIXTURE_KEY_B" } }));
  await page.evaluate(() => window.qa.flushEffects());
  await page.evaluate(() => window.qa.fetch());
  assert.equal(await page.evaluate(() => window.qa.requestCount()), 1);
  await page.evaluate(() => window.qa.fetchCaptured());
  assert.equal(await page.evaluate(() => window.qa.requestCount()), 1, "an obsolete callback cannot send an old payload in a new scope");
  assert.equal((await page.evaluate(() => window.qa.snapshot())).fetching, true);
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("current"));
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["current"]);
}));

test("returning to the same request identity never reauthorizes an earlier scope", () => withPage(async page => {
  for (const outcome of ["resolve", "reject"]) {
    await page.evaluate(input => window.qa.mount(input), scope);
    await page.evaluate(() => window.qa.flushEffects());
    await page.evaluate(() => window.qa.fetch());
    const obsoleteIndex = await page.evaluate(() => window.qa.requestCount() - 1);
    await page.evaluate(() => window.qa.change({ cwd: "/fixture-b" }));
    await page.evaluate(() => window.qa.flushEffects());
    await page.evaluate(() => window.qa.change({ cwd: "/fixture-a" }));
    await page.evaluate(() => window.qa.flushEffects());
    await page.evaluate(() => window.qa.fetch());
    const currentIndex = await page.evaluate(() => window.qa.requestCount() - 1);
    await page.evaluate(({ index, outcome, result }) => window.qa.finish(index, outcome, result), {
      index: obsoleteIndex, outcome, result: response("obsolete-a"),
    });
    assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, []);
    assert.equal((await page.evaluate(() => window.qa.snapshot())).error, "");
    assert.equal((await page.evaluate(() => window.qa.snapshot())).fetching, true);
    await page.evaluate(({ index, result }) => window.qa.finish(index, "resolve", result), { index: currentIndex, result: response("current-a") });
    assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["current-a"]);
  }
}));

test("effective payload equivalence uses trimmed workspace and key plus parsed header references", () => withPage(async page => {
  await page.evaluate(() => window.qa.change({ form: { secretHeaderRefsText: "X-Fixture: env:FIXTURE_A\nY-Fixture: local:fixture-y" } }));
  await page.evaluate(() => window.qa.flushEffects());
  await page.evaluate(() => window.qa.fetch());
  await page.evaluate(() => window.qa.change({ cwd: " /fixture-a ", form: {
    apiKey: " FIXTURE_KEY_A ", secretHeaderRefsText: "# ignored\n  Y-Fixture : local:fixture-y  \n X-Fixture : env:FIXTURE_A ",
  } }));
  await page.evaluate(() => window.qa.flushEffects());
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("canonical"));
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["canonical"]);
}));

test("a new-scope layout consumer request survives the passive cleanup of obsolete discovery", () => withPage(async page => {
  await page.evaluate(() => window.qa.fetch());
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("previous"));
  await page.evaluate(() => window.qa.change({ cwd: "/fixture-b", fetchDuringLayout: true }));
  await page.evaluate(() => window.qa.flushEffects());
  assert.equal(await page.evaluate(() => window.qa.requestCount()), 2);
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, []);
  assert.equal((await page.evaluate(() => window.qa.snapshot())).fetching, true);
  await page.evaluate(result => window.qa.finish(1, "resolve", result), response("fresh-layout"));
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["fresh-layout"]);
}));

test("close and unmount invalidate late results and failures", () => withPage(async page => {
  for (const action of ["close", "unmount"]) {
    for (const outcome of ["resolve", "reject"]) {
      await page.evaluate(input => window.qa.mount(input), scope);
      await page.evaluate(() => window.qa.flushEffects());
      await page.evaluate(() => window.qa.fetch());
      const index = await page.evaluate(() => window.qa.requestCount() - 1);
      await page.evaluate(action => window.qa[action](), action);
      await page.evaluate(({ index, outcome, result }) => window.qa.finish(index, outcome, result), { index, outcome, result: response("late") });
      await page.evaluate(input => window.qa.mount(input), scope);
      await page.evaluate(() => window.qa.flushEffects());
      assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, []);
    }
  }
}));

test("selection can retain discovered source context exactly once without authorizing unrelated scope", () => withPage(async page => {
  await page.evaluate(() => window.qa.fetch());
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("choice", { models: [{ id: "choice", api: "openai-responses", capabilities: ["chat"] }] }));
  await page.evaluate(() => window.qa.selectFirst());
  await page.evaluate(() => window.qa.flushEffects());
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, ["choice"]);
  await page.evaluate(() => window.qa.change({ editingProviderId: "unrelated-preset" }));
  await page.evaluate(() => window.qa.flushEffects());
  assert.deepEqual((await page.evaluate(() => window.qa.snapshot())).models, []);
}));

test("non-request model details do not invalidate discovery; payload stays canonical and private", () => withPage(async page => {
  await page.evaluate(() => window.qa.fetch());
  const sent = await page.evaluate(() => window.qa.lastPayload());
  assert.deepEqual(sent, { cwd: "/fixture-a", payload: { providerPresetId: "preset-a", kind: form.kind,
    providerId: form.providerId, api: form.api, providerTransport: undefined, baseUrl: form.baseUrl, apiKey: form.apiKey, apiKeyRef: form.apiKeyRef,
    secretHeaderRefs: { "X-Fixture": "env:FIXTURE_A" }, authHeader: true } });
  await page.evaluate(() => window.qa.change({ form: { displayName: "Another name", model: "another-model", contextWindow: "64000" } }));
  await page.evaluate(() => window.qa.flushEffects());
  await page.evaluate(result => window.qa.finish(0, "resolve", result), response("same-request"));
  const snapshot = await page.evaluate(() => window.qa.snapshot());
  assert.deepEqual(snapshot.models, ["same-request"]);
  assert.ok(!JSON.stringify(snapshot).includes("FIXTURE_KEY"));
  assert.ok(!(await page.content()).includes("FIXTURE_KEY"));
}));

function harnessSource() {
  return `
    import React, { act, useLayoutEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { useProviderEditorController } from ${JSON.stringify(controllerPath)};
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let root, input, editor, capturedFetch, renderHistory = [], requests = [], pending = [];
    const snapshot = () => ({ models: editor.modelOptions.map(model => model.id), source: editor.modelOptionsSource,
      error: editor.modelFetchError, fetching: editor.isFetchingModels, selectedImportCount: editor.selectedImportCount });
    function Harness() {
      editor = useProviderEditorController({ ...input, providers: [], templates: [], selectedTemplateId: "custom-openai-compatible", setupIntent: "",
        onFormChange(form) { input = { ...input, form }; draw(); }, onTemplateSelect() {}, onNew() {}, onEdit() {},
        onSave: async () => ({ ok: true }), onImportModels: async () => ({ ok: true }) });
      renderHistory.push(snapshot());
      useLayoutEffect(() => {
        window.qa.committed = snapshot();
        if (input.fetchDuringLayout) {
          input = { ...input, fetchDuringLayout: false };
          void editor.fetchModels();
        }
      });
      return React.createElement("div", null, editor.modelOptions.map(model => model.id).join(","));
    }
    const draw = () => flushSync(() => root.render(React.createElement(Harness)));
    window.qa = {
      request(cwd, payload) { const index = requests.length; requests.push({ cwd, payload }); return new Promise((resolve, reject) => pending[index] = { resolve, reject }); },
      mount(next) { root?.unmount(); input = { ...next, form: { ...next.form } }; root = createRoot(document.getElementById("root")); draw(); },
      change(next) { input = { ...input, ...next, form: { ...input.form, ...next.form } }; draw(); },
      fetch() { editor.fetchModels(); },
      captureFetch() { capturedFetch = editor.fetchModels; },
      fetchCaptured() { capturedFetch(); },
      requestCount: () => requests.length,
      lastPayload: () => requests.at(-1),
      async finish(index, outcome, result) { await act(async () => { pending[index][outcome](outcome === "resolve" ? result : new Error("Synthetic rejected discovery")); }); },
      async flushEffects() { await act(async () => {}); },
      close() { flushSync(() => editor.close()); },
      unmount() { root.unmount(); root = undefined; },
      selectFirst() { flushSync(() => editor.selectModel(editor.modelOptions[0])); },
      snapshot, renders: () => renderHistory, clearRenders() { renderHistory = []; },
    };
  `;
}
