import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { _electron, expect, type ElectronApplication } from "@playwright/test";
import { build } from "esbuild";
import { build as buildWebFixture } from "vite";
import type { DesktopBrowserOperation, DesktopBrowserTab } from "@ling-stack/contracts";
import { DesktopBrowserController } from "../../../packages/daemon/dist/features/desktop-browser/controller.js";
import type { BrowserElectronHarness } from "./support/browser-electron-app.ts";
import type { LingDesktopCapabilities } from "../shared/desktop-capabilities.js";

declare global { interface Window { readonly lingDesktop?: LingDesktopCapabilities; browserAddressFocusCount?: number } }

const scope = { surface: "normal_conversation" as const, ownerId: "thread-normal_conversation" };
type Snapshot = { snapshotRevision: string; tabId: string; navigationRevision: number; text: string; elements: { ref: string; label: string; sensitive: boolean }[] };

test("standard Electron browser performs scoped tools through its authenticated HTTP runtime", { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "ling-browser-electron-")), workspaceCwd = join(temporary, "workspace");
  await mkdir(workspaceCwd);
  const controller = new DesktopBrowserController(workspaceCwd), servers: Server[] = [];
  let electron: ElectronApplication | undefined;
  t.after(async () => { await electron?.close(); controller.close(); for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } await rm(temporary, { recursive: true, force: true }); });
  const context = { desktopBridgeToken: "browser-electron-test-token", desktopBrowser: controller,
    desktopBrowserPlugin: { sync() {} }, config: { defaultWorkspaceCwd: workspaceCwd, maxBodyBytes: 3 * 1024 * 1024 } };
  // The bridge fixture supplies only the dependencies owned by the browser route.
  const { handleDesktopBrowserRoute } = await import(new URL("../../../packages/daemon/dist/features/desktop-browser/routes.js", import.meta.url).href) as {
    handleDesktopBrowserRoute(request: IncomingMessage, response: ServerResponse, testContext: typeof context): Promise<boolean>;
  };
  const bridge = createServer((request, response) => { void handleDesktopBrowserRoute(request, response, context).then(handled => { if (!handled) { response.statusCode = 404; response.end(); } }); });
  servers.push(bridge); const daemonBaseUrl = await listen(bridge);
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => { redirectedRequests++; response.end("redirect must not arrive"); });
  servers.push(destination); const destinationUrl = await listen(destination);
  let slowRequests = 0, downloadRequests = 0;
  const site = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: destinationUrl }); response.end(); return; }
    if (request.url === "/slow") { slowRequests++; setTimeout(() => { if (!response.destroyed) response.end("slow response"); }, 800); return; }
    if (request.url === "/download") { downloadRequests++; response.writeHead(200, { "content-disposition": 'attachment; filename="fixture.txt"' }); response.end("browser fixture"); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Browser acceptance</title><style>body{font:20px system-ui;padding:28px}input,button{font:inherit;display:block;margin:14px 0}</style>
      <h1>Browser acceptance</h1><button id="increment">Increment</button><p id="count">Count: 0</p>
      <label>Name<input id="name" placeholder="Name"></label><label>Password<input type="password" placeholder="Password"></label>
      <label>Card<input autocomplete="cc-number" placeholder="Card"></label><input type="file" aria-label="File">
      <script>let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent='Count: '+(++count);</script>`);
  });
  servers.push(site); const siteUrl = await listen(site);
  const support = fileURLToPath(new URL("./support/", import.meta.url));
  const appFile = join(temporary, "browser-app.mjs"), preload = join(temporary, "preload.cjs");
  const webRoot = fileURLToPath(new URL("../../web/", import.meta.url)), webOutput = join(temporary, "web");
  await buildWebFixture({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), logLevel: "error",
    build: { outDir: webOutput, emptyOutDir: true, rollupOptions: { input: join(webRoot, "e2e/support/desktop-browser.html") } } });
  const html = join(webOutput, "e2e/support/desktop-browser.html");
  await build({ entryPoints: [join(support, "browser-electron-app.ts")], outfile: appFile, bundle: true, platform: "node", format: "esm", external: ["electron"], logLevel: "silent" });
  await build({ entryPoints: [join(support, "browser-electron-preload.ts")], outfile: preload, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  const launcher = join(temporary, "launch.cjs");
  await writeFile(launcher, `const { app, dialog } = require("electron"); dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); }; import(${JSON.stringify(pathToFileURL(appFile).href)}).catch(error => { console.error(error); app.exit(1); });`);
  electron = await _electron.launch({ args: [launcher], timeout: 20000, env: { ...process.env, LING_BROWSER_TEST_PROFILE: join(temporary, "profile"),
    LING_BROWSER_TEST_WORKSPACE: workspaceCwd, LING_BROWSER_TEST_DAEMON: daemonBaseUrl, LING_BROWSER_TEST_HTML: html, LING_BROWSER_TEST_PRELOAD: preload } });
  const host = await electron.firstWindow(); await host.waitForLoadState();
  const errors: string[] = []; host.on("pageerror", error => errors.push(error.message));
  const workspace = { workspaceCwd, scope };
  const address = host.getByRole("textbox", { name: "Browser address" });
  try { await expect(address).toBeVisible({ timeout: 10_000 }); }
  catch (error) { throw new Error(JSON.stringify({ body: await host.locator("body").innerText(), errors }), { cause: error }); }
  await address.fill(siteUrl); await host.getByRole("button", { name: "Go", exact: true }).click();
  await expect(host.getByRole("tab", { name: "Browser acceptance", exact: true })).toBeVisible();
  const opened = await host.evaluate(workspace => window.lingDesktop!.browser!.getState(workspace), workspace);
  assert.equal(opened.tabs.length, 1); const tabId = opened.tabs[0]!.id;
  assert.equal(opened.tabs[0]!.control, "human");
  await host.getByRole("button", { name: "Allow agent control", exact: true }).click();
  await waitFor(() => controller.snapshot().state?.tabs[0]?.control === "agent");
  let sequence = 0;
  const current = (): DesktopBrowserTab => { const tab = controller.snapshot().state?.tabs.find(tab => tab.id === tabId); assert.ok(tab); return tab; };
  const invoke = (operation: DesktopBrowserOperation, signal?: AbortSignal) => controller.execute({ operation, scope, runId: "acceptance-run", toolCallId: `call-${++sequence}`, signal });
  const snapshot = () => invoke({ method: "browser_snapshot", params: { tabId, navigationRevision: current().navigationRevision } }) as Promise<Snapshot>;
  let page = await snapshot(); assert.match(page.text, /Browser acceptance/u);
  assert.ok(page.elements.find(element => element.label === "Password")?.sensitive);
  assert.ok(page.elements.find(element => element.label === "Card")?.sensitive);
  for (const label of ["Password", "Card", "File"]) {
    const element = page.elements.find(element => element.label === label); assert.ok(element);
    await assert.rejects(invoke({ method: "browser_click", params: { tabId, navigationRevision: page.navigationRevision,
      snapshotRevision: page.snapshotRevision, ref: element.ref } }), /browser_sensitive_input_forbidden/u);
  }
  const name = page.elements.find(element => element.label === "Name"); assert.ok(name);
  await invoke({ method: "browser_type", params: { tabId, navigationRevision: page.navigationRevision, snapshotRevision: page.snapshotRevision, ref: name.ref, text: "Ling browser" } });
  await assert.rejects(invoke({ method: "browser_type", params: { tabId, navigationRevision: page.navigationRevision, snapshotRevision: page.snapshotRevision, ref: name.ref, text: "stale" } }), /browser_snapshot_stale/u);
  page = await snapshot(); const button = page.elements.find(element => element.label === "Increment"); assert.ok(button);
  await invoke({ method: "browser_click", params: { tabId, navigationRevision: page.navigationRevision, snapshotRevision: page.snapshotRevision, ref: button.ref } });
  assert.match((await snapshot()).text, /Count: 1/u);
  const result = await electron.evaluate(async (_electron, id) => {
    const contents = _electron.webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance");
    if (!contents) throw new Error("Browser fixture page is missing");
    return { page: await contents.executeJavaScript('({value:document.querySelector("#name").value,node:typeof process,require:typeof require,bridge:typeof lingDesktop})'), id };
  }, tabId);
  assert.deepEqual(result.page, { value: "Ling browser", node: "undefined", require: "undefined", bridge: "undefined" });
  const screenshot = await invoke({ method: "browser_screenshot", params: { tabId, navigationRevision: current().navigationRevision } }) as { data: string; mimeType: string };
  assert.equal(screenshot.mimeType, "image/jpeg"); assert.ok(Buffer.from(screenshot.data, "base64").byteLength > 1000);
  const evidence = resolve(import.meta.dirname, "../test-results/desktop-browser"); await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "page.jpg"), Buffer.from(screenshot.data, "base64"));
  const nativeViews = () => electron!.evaluate(({ WebContentsView }) => globalThis.lingBrowserHarness.window.contentView.children
    .filter(view => view instanceof WebContentsView && view.webContents !== globalThis.lingBrowserHarness.window.webContents)
    .map(view => ({ visible: view.getVisible(), bounds: view.getBounds() })));
  const assertViewport = async (): Promise<void> => {
    await expect.poll(async () => {
      const views = await nativeViews(), bounds = await host.locator("[data-browser-viewport]").boundingBox();
      const zoom = await electron!.evaluate(() => globalThis.lingBrowserHarness.window.webContents.getZoomFactor());
      return bounds && views.length === 1 && views[0]!.visible && (["x", "y", "width", "height"] as const).every(key =>
        Math.abs(views[0]!.bounds[key] - Math.round(bounds[key] * zoom)) <= 1);
    }).toBe(true);
  };
  await assertViewport();
  await host.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(host.getByText("Recorded browser evidence", { exact: true })).toBeVisible();
  await expect.poll(nativeViews).toEqual([]);
  await host.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(address).toHaveValue(`${siteUrl}/`); await assertViewport();
  await host.getByRole("button", { name: "Open approval overlay" }).click();
  await expect.poll(nativeViews).toEqual([]);
  await host.getByRole("button", { name: "Dismiss approval overlay" }).click(); await assertViewport();
  await host.getByRole("button", { name: "channel", exact: true }).click();
  await expect(host.getByRole("tab")).toHaveCount(0); await expect.poll(nativeViews).toEqual([]);
  await host.getByRole("button", { name: "normal_conversation", exact: true }).click();
  await expect(address).toHaveValue(`${siteUrl}/`); await assertViewport();
  await electron.evaluate(() => globalThis.lingBrowserHarness.window.setSize(1280, 800)); await assertViewport();
  const dockWidth = (await nativeViews())[0]!.bounds.width;
  await host.getByRole("button", { name: "Expand browser", exact: true }).click(); await assertViewport();
  assert.ok((await nativeViews())[0]!.bounds.width > dockWidth);
  await host.getByRole("button", { name: "Show browser beside chat", exact: true }).click(); await assertViewport();
  await electron.evaluate(() => globalThis.lingBrowserHarness.window.webContents.setZoomFactor(1.15)); await assertViewport();
  await electron.evaluate(() => globalThis.lingBrowserHarness.window.webContents.setZoomFactor(1)); await assertViewport();
  await host.screenshot({ path: join(evidence, "workspace.png") });
  await host.evaluate(() => {
    window.browserAddressFocusCount = 0;
    window.lingDesktop!.browser!.onAddressFocusRequested(() => { window.browserAddressFocusCount!++; });
  });
  await electron.evaluate(_electron => {
    const contents = _electron.webContents.getAllWebContents().find(item => item.getTitle() === "Browser acceptance")!;
    contents.focus(); contents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  });
  await waitFor(async () => (await host.evaluate(() => window.browserAddressFocusCount)) === 1);
  await expect(address).toBeFocused();
  await waitFor(() => current().control === "human");
  await host.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "release_control", tabId: input.tabId }), { workspace, tabId });
  await waitFor(() => current().control === "agent");
  await assert.rejects(controller.execute({ operation: { method: "browser_snapshot", params: { tabId, navigationRevision: current().navigationRevision } },
    scope: { ...scope, ownerId: "other-thread" }, runId: "other-run", toolCallId: "other-call" }), /browser_target_stale_or_forbidden/u);
  await electron.evaluate(async (_electron, input) => {
    const contents = _electron.webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    await contents.executeJavaScript('localStorage.setItem("profile-marker","original")');
    const other = globalThis.lingBrowserHarness.createManager(input.workspaceCwd + "-other");
    try {
      const opened = await other.act({ workspaceCwd: input.workspaceCwd + "-other", scope: input.scope, action: "open", url: input.url });
      const secondary = _electron.webContents.getAllWebContents().find(item => item !== contents && item.getTitle() === "Browser acceptance")!;
      if (await secondary.executeJavaScript('localStorage.getItem("profile-marker")') !== null) throw new Error("browser profiles share site storage");
      await other.act({ workspaceCwd: input.workspaceCwd + "-other", scope: input.scope, action: "close", tabId: opened.tabs[0]!.id });
    } finally { other.dispose(); }
  }, { workspaceCwd, scope, url: siteUrl });
  const permission = await electron.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    return contents.executeJavaScript('navigator.permissions.query({name:"geolocation"}).then(result=>result.state)');
  });
  assert.equal(permission, "denied");
  await electron.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    await contents.executeJavaScript('window.open("https://example.com", "_blank"); null');
  });
  await waitFor(() => current().error === "browser_popup_blocked");
  await electron.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    await contents.executeJavaScript(`location.href = ${JSON.stringify(`${url}/download`)}; null`);
  }, siteUrl);
  await waitFor(() => downloadRequests === 1 && current().error === "browser_download_blocked");
  await assert.rejects(invoke({ method: "browser_navigate", params: { tabId, navigationRevision: current().navigationRevision, url: `${siteUrl}/redirect` } }));
  assert.equal(redirectedRequests, 0);
  await host.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "take_control", tabId: input.tabId }), { workspace, tabId });
  await waitFor(() => controller.snapshot().state?.tabs[0]?.control === "human");
  await assert.rejects(snapshot(), /browser_target_stale_or_forbidden/u);
  await host.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "release_control", tabId: input.tabId }), { workspace, tabId });
  await waitFor(() => current().control === "agent");
  const abort = new AbortController();
  const cancelled = invoke({ method: "browser_navigate", params: { tabId, navigationRevision: current().navigationRevision, url: `${siteUrl}/slow` } }, abort.signal);
  const rejected = assert.rejects(cancelled, error => error instanceof Error && "effect" in error && error.effect === "unknown");
  await waitFor(() => slowRequests === 1); abort.abort(); await rejected;
  await waitFor(() => current().control === "human");
  assert.equal(slowRequests, 1);
  assert.deepEqual(errors, []);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object"); return `http://127.0.0.1:${address.port}`;
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) assert.fail("Browser runtime did not reach the expected state"); await delay(20); }
}
