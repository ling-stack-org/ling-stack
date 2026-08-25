import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
  CHROME_BROWSER_PLUGIN_ID,
} from "@ling-stack/contracts";
import { createSqliteRunStore } from "../../../packages/core/dist/index.js";
import {
  ChromeBrowserSessionController,
  attachChromeBrowserWebSocketServer,
  handleChromeBrowserPair,
} from "../../../packages/daemon/dist/index.js";

const extensionRoot = resolve(import.meta.dirname, "../../chrome-extension/dist");
const colorScheme = process.env.LING_CHROME_SMOKE_COLOR_SCHEME === "dark" ? "dark" : "light";
const browserChannel = process.env.LING_CHROME_SMOKE_CHANNEL === "chrome" ? "chrome" : "chromium";
const browserLocale = process.env.LING_CHROME_SMOKE_LOCALE === "zh-CN" ? "zh-CN" : "en-US";
const workspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-chrome-real-workspace-"));
const profileDir = await mkdtemp(resolve(tmpdir(), "ling-chrome-real-profile-"));
const store = createSqliteRunStore(workspaceCwd);
const descriptor = {
  id: CHROME_BROWSER_PLUGIN_ID,
  displayName: "Chrome",
  version: "0.1.0",
  sourceKind: "built-in",
  trustSummary: "Real Chrome smoke fixture.",
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
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/browser-extension/v1/pair") {
    await handleChromeBrowserPair(request, response, {
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024 * 1024,
    }, controller);
    return;
  }
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
const websocket = attachChromeBrowserWebSocketServer({
  server,
  controller,
  host: "127.0.0.1",
  port: 0,
  workspaceCwd,
});

let context;
try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const pairing = controller.createPairing(workspaceCwd);
  console.log("chrome-smoke:launch");

  context = await chromium.launchPersistentContext(profileDir, {
    channel: browserChannel,
    headless: true,
    colorScheme,
    locale: browserLocale,
    timeout: 20_000,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const popup = await context.newPage();
  popup.setDefaultTimeout(10_000);
  await popup.setViewportSize({ width: 360, height: 600 });
  console.log("chrome-smoke:popup");
  await popup.goto(`chrome-extension://${CHROME_BROWSER_PRODUCTION_EXTENSION_ID}/popup.html`);
  await popup.evaluate((daemonBaseUrl) => chrome.storage.local.set({ "ling.chrome.daemonBaseUrl": daemonBaseUrl }), baseUrl);
  await popup.reload();
  const consentScreenshot = `/tmp/ling-chrome-extension-consent-${colorScheme}-${browserLocale}.png`;
  await popup.screenshot({ path: consentScreenshot });
  await popup.locator("#cwd").fill(workspaceCwd);
  await popup.locator("#pairing-code").fill(pairing.pairingCode);
  await popup.locator("#connect").waitFor({ state: "visible" });
  assert.equal(await popup.locator("#connect").isDisabled(), true);
  await popup.locator("#consent").check();
  assert.equal(await popup.locator("#connect").isEnabled(), true);
  await popup.locator("#connect").click();
  console.log("chrome-smoke:pairing-submitted");
  await waitFor(() => controller.snapshot(workspaceCwd).connected, 8_000);
  await popup.locator("#connected").waitFor({ state: "visible" });
  await popup.locator("#pairing").waitFor({ state: "hidden" });
  assert.equal(await popup.locator("#pairing-code").inputValue(), "");
  console.log("chrome-smoke:connected");

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${baseUrl}/fixture`);
  console.log("chrome-smoke:fixture");
  const tabs = await controller.execute(workspaceCwd, "chrome_tabs", {});
  const target = tabs.find((tab) => tab.url === `${baseUrl}/fixture`);
  assert.ok(target?.id);

  const snapshot = await controller.execute(workspaceCwd, "chrome_snapshot", { tabId: target.id });
  console.log("chrome-smoke:snapshot");
  assert.match(snapshot.text, /Ling Chrome Smoke/);
  const button = snapshot.elements.find((element) => element.label === "Increment");
  const input = snapshot.elements.find((element) => element.label === "Name");
  assert.ok(button?.ref && input?.ref);

  await controller.execute(workspaceCwd, "chrome_click", {
    tabId: target.id,
    ref: button.ref,
    snapshotRevision: snapshot.snapshotRevision,
  });
  await page.locator("#count").waitFor({ state: "visible" });
  assert.equal(await page.locator("#count").textContent(), "1");
  console.log("chrome-smoke:click");

  const nextSnapshot = await controller.execute(workspaceCwd, "chrome_snapshot", { tabId: target.id });
  const nextInput = nextSnapshot.elements.find((element) => element.label === "Name");
  await controller.execute(workspaceCwd, "chrome_type", {
    tabId: target.id,
    ref: nextInput.ref,
    text: "Ling typed this",
    snapshotRevision: nextSnapshot.snapshotRevision,
  });
  assert.equal(await page.locator("#name").inputValue(), "Ling typed this");
  console.log("chrome-smoke:type");

  await controller.execute(workspaceCwd, "chrome_navigate", { tabId: target.id, url: `${baseUrl}/fixture-next` });
  await page.waitForURL(`${baseUrl}/fixture-next`);
  const screenshot = await controller.execute(workspaceCwd, "chrome_screenshot", { tabId: target.id });
  assert.equal(screenshot.mimeType, "image/jpeg");
  assert.equal(typeof screenshot.data, "string");
  assert.equal(screenshot.data.length > 100, true);
  console.log("chrome-smoke:screenshot");
  const popupScreenshot = `/tmp/ling-chrome-extension-popup-${colorScheme}-${browserLocale}.png`;
  const pageScreenshot = `/tmp/ling-chrome-extension-page-${colorScheme}-${browserLocale}.png`;
  await popup.screenshot({ path: popupScreenshot });
  await page.screenshot({ path: pageScreenshot });

  assert.equal(controller.revoke(workspaceCwd), 1);
  await waitForAsync(async () => {
    const stored = await popup.evaluate(() => chrome.storage.local.get([
      "ling.chrome.credential",
      "ling.chrome.cwd",
    ]));
    return stored["ling.chrome.credential"] === undefined && stored["ling.chrome.cwd"] === undefined;
  }, 8_000);
  await popup.locator("#pairing").waitFor({ state: "visible" });
  await popup.locator("#connected").waitFor({ state: "hidden" });
  console.log("chrome-smoke:revoked");

  console.log(JSON.stringify({
    ok: true,
    extensionId: CHROME_BROWSER_PRODUCTION_EXTENSION_ID,
    toolChecks: ["chrome_tabs", "chrome_snapshot", "chrome_click", "chrome_type", "chrome_navigate", "chrome_screenshot"],
    colorScheme,
    browserChannel,
    browserLocale,
    consentScreenshot,
    popupScreenshot,
    pageScreenshot,
  }));
} finally {
  await context?.close();
  websocket.close();
  controller.close();
  await closeServer(server);
  store.close();
  await rm(profileDir, { recursive: true, force: true });
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
  return new Promise((resolvePromise) => target.close(() => resolvePromise()));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Chrome smoke condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function waitForAsync(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Chrome smoke condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}
