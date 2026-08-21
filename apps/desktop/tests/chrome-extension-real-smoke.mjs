import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  browserHostManifestPaths,
  installBrowserHost,
} from "@ling-stack/browser-host";
import {
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
  CHROME_BROWSER_PLUGIN_ID,
} from "@ling-stack/contracts";
import { createSqliteRunStore } from "../../../packages/core/dist/index.js";
import {
  ChromeBrowserPluginService,
  ChromeBrowserSessionController,
  createChromeBrowserNativeBroker,
} from "../../../packages/daemon/dist/index.js";

if (process.platform !== "darwin") {
  throw new Error("chrome_extension_real_smoke_requires_macos");
}

const extensionRoot = resolve(import.meta.dirname, "../../chrome-extension/dist");
const hostPath = resolve(import.meta.dirname, "../../../packages/browser-host/dist/native/ling-browser-host");
const colorScheme = process.env.LING_CHROME_SMOKE_COLOR_SCHEME === "dark" ? "dark" : "light";
const browserChannel = process.env.LING_CHROME_SMOKE_CHANNEL === "chromium" ? "chromium" : "chrome";
const browserLocale = process.env.LING_CHROME_SMOKE_LOCALE === "zh-CN" ? "zh-CN" : "en-US";
const headless = process.env.LING_CHROME_SMOKE_HEADLESS !== "0";
const preinstalledExtension = process.env.LING_CHROME_SMOKE_PREINSTALLED === "1";
const workspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-chrome-real-workspace-"));
const suppliedProfileDir = process.env.LING_CHROME_SMOKE_PROFILE_DIR?.trim();
const profileDir = suppliedProfileDir || await mkdtemp(resolve(tmpdir(), "ling-chrome-real-profile-"));
const descriptorPath = resolve(workspaceCwd, "browser-host/runtime-v1.json");
const store = createSqliteRunStore(workspaceCwd);
const descriptor = {
  id: CHROME_BROWSER_PLUGIN_ID,
  displayName: "Chrome",
  version: "0.1.1",
  sourceKind: "built-in",
  trustSummary: "Real Chrome Native Messaging smoke fixture.",
  contributions: [],
};
store.upsertManagedPlugin({
  id: descriptor.id,
  sourceKind: descriptor.sourceKind,
  version: descriptor.version,
  enabled: true,
  descriptor,
}, new Date().toISOString());
const controller = new ChromeBrowserSessionController({
  workspaceCwd,
  allowedExtensionIds: [CHROME_BROWSER_PRODUCTION_EXTENSION_ID],
  getStore: () => store,
});
const plugin = new ChromeBrowserPluginService({ controller, getStore: () => store, hostPath });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/fixture" || url.pathname === "/fixture-next") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html><head><title>Ling Chrome Smoke</title></head>
      <body>
        <h1>Ling Chrome Smoke</h1>
        <button id="increment">Increment</button>
        <span id="count">0</span>
        <input id="name" placeholder="Name" />
        <script>
          document.querySelector('#increment').addEventListener('click', () => {
            const count = document.querySelector('#count');
            count.textContent = String(Number(count.textContent) + 1);
          });
        </script>
      </body></html>`);
    return;
  }
  response.statusCode = 404;
  response.end();
});
const broker = createChromeBrowserNativeBroker({
  controller,
  workspaceCwd,
  descriptorPath,
  hostPath,
});
const manifestPaths = browserHostManifestPaths({ platform: "darwin" });
const manifestBackups = await Promise.all(manifestPaths.map(readOptionalFile));

let context;
try {
  await installBrowserHost({ hostPath });
  await listen(server);
  await broker.start();
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log("chrome-smoke:launch-native");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: browserChannel,
    headless,
    colorScheme,
    locale: browserLocale,
    timeout: 20_000,
    env: {
      ...process.env,
      LING_BROWSER_HOST_RUNTIME_DESCRIPTOR: descriptorPath,
    },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      ...(!preinstalledExtension ? [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
      ] : []),
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const popup = await context.newPage();
  popup.setDefaultTimeout(10_000);
  await popup.setViewportSize({ width: 360, height: 520 });
  await popup.goto(`chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}/popup.html`);
  await waitForNativeConnection(popup, controller, workspaceCwd, manifestPaths, 10_000);
  await waitForExtensionState(popup, "connected", 10_000);
  assert.equal(await popup.locator("#cwd, #pairing-code, #consent").count(), 0);
  assert.equal(controller.snapshot(workspaceCwd).transport, "native_messaging");
  console.log("chrome-smoke:native-connected");

  await popup.locator("#primary-action").click();
  await waitForExtensionState(popup, "paused", 10_000);
  await waitFor(() => !controller.snapshot(workspaceCwd).connected, 10_000);
  await popup.locator("#primary-action").click();
  await waitFor(() => controller.snapshot(workspaceCwd).connected, 10_000);
  await waitForExtensionState(popup, "connected", 10_000);
  console.log("chrome-smoke:pause-resume");

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${baseUrl}/fixture`);
  const tabs = await controller.execute(workspaceCwd, "chrome_tabs", {});
  const target = tabs.find((tab) => tab.url === `${baseUrl}/fixture`);
  assert.ok(target?.id);

  const snapshot = await controller.execute(workspaceCwd, "chrome_snapshot", { tabId: target.id });
  assert.match(snapshot.text, /Ling Chrome Smoke/);
  const button = snapshot.elements.find((element) => element.label === "Increment");
  const input = snapshot.elements.find((element) => element.label === "Name");
  assert.ok(button?.ref && input?.ref);

  await controller.execute(workspaceCwd, "chrome_click", {
    tabId: target.id,
    ref: button.ref,
    snapshotRevision: snapshot.snapshotRevision,
  });
  assert.equal(await page.locator("#count").textContent(), "1");

  const nextSnapshot = await controller.execute(workspaceCwd, "chrome_snapshot", { tabId: target.id });
  const nextInput = nextSnapshot.elements.find((element) => element.label === "Name");
  await controller.execute(workspaceCwd, "chrome_type", {
    tabId: target.id,
    ref: nextInput.ref,
    text: "Ling typed this",
    snapshotRevision: nextSnapshot.snapshotRevision,
  });
  assert.equal(await page.locator("#name").inputValue(), "Ling typed this");

  await controller.execute(workspaceCwd, "chrome_navigate", { tabId: target.id, url: `${baseUrl}/fixture-next` });
  await page.waitForURL(`${baseUrl}/fixture-next`);
  const screenshot = await controller.execute(workspaceCwd, "chrome_screenshot", { tabId: target.id });
  assert.equal(screenshot.mimeType, "image/jpeg");
  assert.equal(typeof screenshot.data, "string");
  assert.equal(screenshot.data.length > 100, true);
  console.log("chrome-smoke:six-tools");

  plugin.disable(workspaceCwd, "real-smoke");
  await waitFor(() => !controller.snapshot(workspaceCwd).connected, 10_000);
  await waitForExtensionState(popup, "plugin_disabled", 10_000);
  plugin.enable(workspaceCwd);
  await popup.locator("#primary-action").click();
  await waitFor(() => controller.snapshot(workspaceCwd).connected, 10_000);
  await waitForExtensionState(popup, "connected", 10_000);
  console.log("chrome-smoke:disable-reenable");

  const popupScreenshot = `/tmp/ling-chrome-extension-popup-${colorScheme}-${browserLocale}.png`;
  const pageScreenshot = `/tmp/ling-chrome-extension-page-${colorScheme}-${browserLocale}.png`;
  await popup.screenshot({ path: popupScreenshot });
  await page.screenshot({ path: pageScreenshot });

  console.log(JSON.stringify({
    ok: true,
    extensionId: CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
    transport: "native_messaging",
    toolChecks: ["chrome_tabs", "chrome_snapshot", "chrome_click", "chrome_type", "chrome_navigate", "chrome_screenshot"],
    lifecycleChecks: ["automatic_connect", "pause", "resume", "disable", "reenable"],
    colorScheme,
    browserChannel,
    browserLocale,
    headless,
    preinstalledExtension,
    popupScreenshot,
    pageScreenshot,
  }));
} finally {
  await context?.close();
  await broker.close();
  controller.close();
  await closeServer(server);
  store.close();
  await restoreManifests(manifestPaths, manifestBackups);
  if (!suppliedProfileDir) await rm(profileDir, { recursive: true, force: true });
  await rm(workspaceCwd, { recursive: true, force: true });
}

function listen(target) {
  return new Promise((resolvePromise, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(target) {
  if (!target.listening) return Promise.resolve();
  return new Promise((resolvePromise) => target.close(() => resolvePromise()));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Chrome smoke condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function waitForExtensionState(popup, expected, timeoutMs) {
  await waitFor(async () => popup.evaluate(async (state) => {
    const response = await chrome.runtime.sendMessage({ type: "status" });
    return response?.state === state;
  }, expected), timeoutMs);
}

async function waitForNativeConnection(popup, sessionController, cwd, paths, timeoutMs) {
  try {
    await waitFor(() => sessionController.snapshot(cwd).connected, timeoutMs);
  } catch (error) {
    const extensionStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" })).catch((failure) => ({ error: String(failure) }));
    const manifests = await Promise.all(paths.map(async (path) => ({ path, content: String(await readOptionalFile(path)) })));
    console.error("chrome-smoke:native-diagnostic", JSON.stringify({ extensionStatus, manifests }));
    throw error;
  }
}

async function readOptionalFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreManifests(paths, backups) {
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const backup = backups[index];
    if (!backup) {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, backup, { mode: 0o600 });
  }
}
