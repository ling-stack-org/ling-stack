import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { _electron, expect, type ElectronApplication } from "@playwright/test";
import { build } from "esbuild";
import { build as buildWebFixture } from "vite";
import type { DesktopBrowserOperation, DesktopBrowserTab } from "@ling-stack/contracts";
import { DesktopBrowserController } from "../../../packages/daemon/dist/features/desktop-browser/controller.js";
import type { BrowserElectronHarness } from "./support/browser-electron-app.ts";
import type { DesktopBrowserAnnotation } from "../shared/browser-annotations.js";
import type { LingDesktopCapabilities } from "../shared/desktop-capabilities.js";

declare global { interface Window { readonly lingDesktop?: LingDesktopCapabilities; browserAddressFocusCount?: number } }

const scope = { surface: "normal_conversation" as const, ownerId: "thread-normal_conversation" };
type Snapshot = { snapshotRevision: string; tabId: string; navigationRevision: number; text: string; elements: { ref: string; label: string; sensitive: boolean }[] };

test("standard Electron browser performs scoped tools through its authenticated HTTP runtime", { timeout: 90000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "ling-browser-electron-")), workspaceCwd = join(temporary, "workspace");
  await mkdir(workspaceCwd); await mkdir(join(temporary, "workspace-secondary"));
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
      <script>if(document.modelContext?.registerTool) { window.fixtureToolController=new AbortController(); Promise.resolve(document.modelContext.registerTool({name:'fixture_title',description:'Return the page title',inputSchema:{type:'object',properties:{},additionalProperties:false},execute(){return document.title}}, {signal:window.fixtureToolController.signal})).catch(console.error); } let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent='Count: '+(++count);</script>`);
  });
  servers.push(site); const siteUrl = await listen(site);
  const support = fileURLToPath(new URL("./support/", import.meta.url));
  const appFile = join(temporary, "browser-app.mjs"), preload = join(temporary, "preload.cjs");
  const webRoot = fileURLToPath(new URL("../../web/", import.meta.url)), webOutput = join(temporary, "web");
  await buildWebFixture({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), logLevel: "error",
    build: { outDir: webOutput, emptyOutDir: true, rollupOptions: { input: join(webRoot, "e2e/support/desktop-browser.html") } } });
  const html = join(webOutput, "e2e/support/desktop-browser.html");
  await build({ entryPoints: [join(support, "browser-electron-app.ts")], outfile: appFile, bundle: true, platform: "node", format: "esm", external: ["electron"],
    banner: { js: "import { createRequire as lingFixtureCreateRequire } from 'node:module'; const require = lingFixtureCreateRequire(import.meta.url);" }, logLevel: "silent" });
  await build({ entryPoints: [fileURLToPath(new URL("../main/browser/schema-worker.ts", import.meta.url))], outfile: join(temporary, "schema-worker.js"), bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  await build({ entryPoints: [join(support, "browser-electron-preload.ts")], outfile: preload, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  const launcher = join(temporary, "launch.cjs");
  await writeFile(launcher, `const { app, dialog } = require("electron"); dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); }; import("./browser-app.mjs").catch(error => { console.error(error); app.exit(1); });`);
  const launchBrowser = () => _electron.launch({ args: [launcher], timeout: 20000, env: { ...process.env, LING_BROWSER_TEST_PROFILE: join(temporary, "profile"),
    LING_BROWSER_TEST_WORKSPACE: workspaceCwd, LING_BROWSER_TEST_DAEMON: daemonBaseUrl, LING_BROWSER_TEST_HTML: html, LING_BROWSER_TEST_PRELOAD: preload } });
  electron = await launchBrowser();
  t.diagnostic(await electron.evaluate(() => `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform}/${process.arch}`));
  const host = await electron.firstWindow(); await host.waitForLoadState();
  const settings = await host.evaluate(cwd => window.lingDesktop!.browser!.getSettingsState(cwd), workspaceCwd);
  assert.equal(settings.devices.length, 0);
  const profileSize = await host.evaluate(cwd => window.lingDesktop!.browser!.getProfileSize(cwd, "current"), workspaceCwd);
  assert.equal(profileSize.category, "browser");
  assert.equal(profileSize.status, "complete");
  const deniedDevice = await host.evaluate(({ cwd, origin }) => window.lingDesktop!.browser!.actSettings({ workspaceCwd: cwd,
    action: "device_permission", rule: { origin, permission: "camera", decision: "deny" } }),
  { cwd: workspaceCwd, origin: new URL(siteUrl).origin });
  assert.deepEqual(deniedDevice.devices, [{ origin: new URL(siteUrl).origin, permission: "camera", decision: "deny" }]);
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
    const contents = (await Promise.all(webContents.getAllWebContents().filter(contents => contents.getTitle() === "Browser acceptance").map(async item => ({ item, marker: await item.executeJavaScript('localStorage.getItem("profile-marker")') })))).find(value => value.marker === "original")!.item;
    await contents.executeJavaScript('window.open("https://example.com", "_blank"); null');
  });
  await waitFor(() => current().error === "browser_popup_blocked");
  await electron.evaluate(async ({ webContents }, url) => {
    const contents = (await Promise.all(webContents.getAllWebContents().filter(contents => contents.getTitle() === "Browser acceptance").map(async item => ({ item, marker: await item.executeJavaScript('localStorage.getItem("profile-marker")') })))).find(value => value.marker === "original")!.item;
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
  await address.fill(siteUrl); await host.getByRole("button", { name: "Go", exact: true }).click();
  await expect(address).toHaveValue(`${siteUrl}/`);
  await waitFor(() => !current().loading);
  await host.getByRole("button", { name: "Allow agent control", exact: true }).click();
  await waitFor(() => current().control === "agent");
  const previousGeneration = controller.snapshot().state!.generation;
  await electron.close(); electron = undefined;
  const metadataFiles = await readdir(join(temporary, "profile", "browser-profiles"));
  const metadata = await Promise.all(metadataFiles.map(file => readFile(join(temporary, "profile", "browser-profiles", file), "utf8")));
  assert.ok(metadata.some(value => JSON.parse(value).workspaceCwd === workspaceCwd && JSON.parse(value).tabs.length === 1), JSON.stringify(metadata));
  electron = await launchBrowser();
  const reopened = await electron.firstWindow();
  await expect(reopened.getByRole("textbox", { name: "Browser address" })).toHaveValue(`${siteUrl}/`);
  await expect.poll(() => electron!.evaluate(({ webContents }) => webContents.getAllWebContents().some(contents => contents.getTitle() === "Browser acceptance"))).toBe(true);
  const restored = await reopened.evaluate(workspace => window.lingDesktop!.browser!.getState(workspace), workspace);
  assert.equal(restored.tabs.length, 1); assert.notEqual(restored.tabs[0]!.id, tabId);
  assert.equal(restored.tabs[0]!.control, "human"); assert.ok(restored.generation > previousGeneration);
  const marker = await electron.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    return contents.executeJavaScript('localStorage.getItem("profile-marker")');
  });
  assert.equal(marker, "original"); assert.equal(slowRequests, 1);
  const restoredTab = restored.tabs[0]!;
  const selection = reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "annotate", tabId: input.tabId, kind: "element", screenshot: true }), { workspace, tabId: restoredTab.id });
  await delay(100);
  await electron.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    const rect = await contents.executeJavaScript('JSON.stringify(document.querySelector("#increment").getBoundingClientRect())');
    const box = JSON.parse(rect); const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    contents.sendInputEvent({ type: "mouseMove", x, y }); contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }); contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  });
  const annotated = await selection; assert.ok(annotated.annotation); const annotation: DesktopBrowserAnnotation = annotated.annotation;
  assert.equal(annotation.anchor.kind, "element"); assert.equal(annotation.anchor.excerpt, "Increment"); assert.ok(annotation.screenshot?.data);
  assert.equal(annotated.tabs[0]!.control, "human");
  const { screenshot: _image, ...metadataOnly } = annotation;
  const located = await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "locate_annotation", annotation: input.annotation }), { workspace, annotation: metadataOnly });
  assert.equal(located.annotationStatus, "available");
  await assert.rejects(reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, scope: { surface: "channel", ownerId: "another-thread" }, action: "locate_annotation", annotation: input.annotation }), { workspace, annotation: metadataOnly }), /browser_annotation_forbidden/u);
  const regionSelection = reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "annotate", tabId: input.tabId, kind: "region", screenshot: true }), { workspace, tabId: restoredTab.id });
  await delay(100);
  await electron.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    contents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseMove", x: 230, y: 130 });
    contents.sendInputEvent({ type: "mouseUp", x: 230, y: 130, button: "left", clickCount: 1 });
  });
  const region = (await regionSelection).annotation!;
  assert.equal(region.anchor.kind, "region"); assert.equal(region.anchor.rect.width, 200); assert.equal(region.anchor.rect.height, 100); assert.ok(region.screenshot?.data);
  const { screenshot: _regionImage, ...regionMetadata } = region;
  const locateRegion = () => reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "locate_annotation", annotation: input.annotation }), { workspace, annotation: regionMetadata });
  assert.equal((await locateRegion()).annotationStatus, "available");
  await electron.evaluate(async ({ webContents }) => { const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!; contents.setZoomFactor(1.1); });
  assert.equal((await locateRegion()).annotationStatus, "stale");
  await electron.evaluate(async ({ webContents }) => { const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!; contents.setZoomFactor(1); await contents.executeJavaScript('document.body.style.minHeight="2000px";scrollTo(0,100);null'); });
  assert.equal((await locateRegion()).annotationStatus, "stale");
  await electron.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    await contents.executeJavaScript('if(document.querySelector("#count").textContent !== "Count: 0") throw new Error("selection clicked the page"); document.querySelector("#increment").remove(); null');
  });
  const stale = await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "locate_annotation", annotation: input.annotation }), { workspace, annotation: metadataOnly });
  assert.equal(stale.annotationStatus, "stale");
  await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "release_control", tabId: input.tabId }), { workspace, tabId: restoredTab.id });
  await waitFor(() => controller.snapshot().state?.tabs.find(tab => tab.id === restoredTab.id)?.control === "agent");
  const restoredRevision = (): number => controller.snapshot().state!.tabs.find(tab => tab.id === restoredTab.id)!.navigationRevision;
  const history = await invoke({ method: "browser_history", params: { query: "127.0.0.1", limit: 20 } }) as { url: string }[];
  assert.ok(history.some(entry => entry.url === `${siteUrl}/`));
  await electron.evaluate(async ({ webContents }) => { const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!; await contents.executeJavaScript('console.error("fixture diagnostic token=private-value"); null'); });
  const debug = await invoke({ method: "browser_debug", params: { tabId: restoredTab.id, navigationRevision: restoredRevision() } });
  assert.match(JSON.stringify(debug), /fixture diagnostic/u); assert.doesNotMatch(JSON.stringify(debug), /private-value/u);
  const webTools = await invoke({ method: "browser_webmcp_tools", params: { tabId: restoredTab.id, navigationRevision: restoredRevision() } }) as { available: boolean; toolRevision?: string; tools: { name: string }[] };
  t.diagnostic(`Public WebMCP consumer API available: ${webTools.available}`);
  assert.equal(webTools.available, true, "The supported Electron runtime must expose native WebMCP");
  if (webTools.available) {
    assert.ok(webTools.tools.some(tool => tool.name === "fixture_title"));
    const result = await invoke({ method: "browser_webmcp_call", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), name: "fixture_title", toolRevision: webTools.toolRevision!, arguments: {} } });
    assert.match(JSON.stringify(result), /Browser acceptance/u);
    await assert.rejects(invoke({ method: "browser_webmcp_call", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), name: "fixture_title", toolRevision: webTools.toolRevision!, arguments: { unexpected: true } } }), /browser_webmcp_arguments_invalid/u);
    await electron.evaluate(async ({ webContents }) => { const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!; await contents.executeJavaScript('window.fixtureToolController.abort(); null'); });
    await assert.rejects(invoke({ method: "browser_webmcp_call", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), name: "fixture_title", toolRevision: webTools.toolRevision!, arguments: {} } }), /browser_webmcp_tools_stale/u);
  } else assert.equal(webTools.tools.length, 0);
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const cdp = await invoke({ method: "browser_cdp", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), method: "Performance.getMetrics", params: {} } });
  assert.match(JSON.stringify(cdp), /metrics/u);
  assert.equal(await electron.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!.debugger.isAttached()), false);
  await assert.rejects(invoke({ method: "browser_cdp", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), method: "Network.getCookies", params: {} } }), /browser_cdp_method_forbidden/u);
  await reopened.evaluate(workspace => window.lingDesktop!.browser!.act({ ...workspace, action: "download_preferences", askBeforeDownload: false }), workspace);
  await invoke({ method: "browser_download", params: { tabId: restoredTab.id, navigationRevision: restoredRevision(), url: `${siteUrl}/download` } });
  let downloadPath = "";
  await waitFor(async () => {
    const state = await reopened.evaluate(workspace => window.lingDesktop!.browser!.getState(workspace), workspace);
    const item = state.management?.downloads.find(item => item.status === "completed"); downloadPath = item?.path ?? ""; return Boolean(item);
  });
  assert.equal(await readFile(downloadPath, "utf8"), "browser fixture"); assert.ok(downloadPath.startsWith(join(temporary, "profile", "downloads")));
  const extensionPath = join(temporary, "extension"); await mkdir(extensionPath);
  await writeFile(join(extensionPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Browser acceptance extension", version: "1.0.0", content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }] }));
  await writeFile(join(extensionPath, "content.js"), 'document.documentElement.dataset.fixtureExtension="active";');
  await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, extensionPath);
  const extended = await reopened.evaluate(workspace => window.lingDesktop!.browser!.act({ ...workspace, action: "extension_install" }), workspace);
  assert.equal(extended.management?.extensions[0]?.name, "Browser acceptance extension");
  await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "reload", tabId: input.tabId }), { workspace, tabId: restoredTab.id });
  await expect.poll(() => electron!.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!;
    return contents.executeJavaScript('document.documentElement.dataset.fixtureExtension');
  })).toBe("active");
  await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "extension_remove", id: input.id }), { workspace, id: extended.management!.extensions[0]!.id });
  const bookmarkFile = join(temporary, "bookmarks.json");
  await writeFile(bookmarkFile, JSON.stringify({ roots: { bookmark_bar: { children: [{ type: "url", name: "Imported preview", url: `${siteUrl}/imported` }, { type: "url", name: "Forbidden protocol", url: "file:///secret" }] } } }));
  await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, bookmarkFile);
  const previewed = await reopened.evaluate(workspace => window.lingDesktop!.browser!.act({ ...workspace, action: "import_preview" }), workspace);
  assert.deepEqual(previewed.management?.importPreview, [{ title: "Imported preview", url: `${siteUrl}/imported` }]);
  assert.equal(previewed.management?.history.some(item => item.url.endsWith("/imported")), false);
  const imported = await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "import_apply", urls: input.urls }), { workspace, urls: [`${siteUrl}/imported`] });
  assert.equal(imported.management?.history.some(item => item.url.endsWith("/imported")), true);
  const cleared = await reopened.evaluate(workspace => window.lingDesktop!.browser!.act({ ...workspace, action: "clear_data", cookies: true, storage: true, cache: true, history: true }), workspace);
  assert.equal(cleared.tabs.length, 0); assert.equal(cleared.management?.history.length, 0); assert.ok(cleared.generation > restored.generation);
  const clean = await reopened.evaluate(input => window.lingDesktop!.browser!.act({ ...input.workspace, action: "open", url: input.url }), { workspace, url: siteUrl });
  assert.equal(clean.tabs[0]?.control, "human");
  assert.equal(await electron.evaluate(async ({ webContents }) => { const contents = webContents.getAllWebContents().find(contents => contents.getTitle() === "Browser acceptance")!; return contents.executeJavaScript('localStorage.getItem("profile-marker")'); }), null);
  assert.equal(await reopened.evaluate(() => localStorage.getItem("ling-stack.locale")), "en-US");
  await reopened.getByRole("button", { name: "Switch workspace", exact: true }).click();
  await reopened.getByRole("textbox", { name: "Browser address" }).fill(siteUrl);
  await reopened.getByRole("button", { name: "Go", exact: true }).click();
  await expect(reopened.getByRole("tab", { name: "Browser acceptance", exact: true })).toBeVisible();
  await electron.evaluate(async ({ webContents }) => { const pages = webContents.getAllWebContents().filter(contents => contents.getTitle() === "Browser acceptance"); await pages.at(-1)!.executeJavaScript('localStorage.setItem("profile-marker","secondary")'); });
  const secondarySnapshot = controller.snapshot().state?.tabs.find(item => item.url === `${siteUrl}/`);
  assert.ok(secondarySnapshot);
  await assert.rejects(controller.execute({ operation: { method: "browser_snapshot", params: { tabId: secondarySnapshot.id, navigationRevision: secondarySnapshot.navigationRevision } }, scope, runId: "old-workspace-run", toolCallId: "old-workspace-call" }), /browser_target_stale_or_forbidden|browser_workspace_paused/u);
  assert.equal(await electron.evaluate(async ({ webContents }) => {
    const pages = webContents.getAllWebContents().filter(contents => contents.getTitle() === "Browser acceptance");
    return (await Promise.all(pages.map(contents => contents.executeJavaScript('localStorage.getItem("profile-marker")')))).includes("secondary");
  }), true, "Clearing one workspace must preserve the other profile");
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
