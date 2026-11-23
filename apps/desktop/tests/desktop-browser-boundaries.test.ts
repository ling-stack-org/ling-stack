import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { assertBrowserNetworkUrl, isBrowserPublicAddress } from "../dist/main/browser/url-policy.js";
import { assertBrowserIpcSender, parseBrowserSettingsAction, parseBrowserUserAction, parseBrowserViewport } from "../dist/main/browser/ipc.js";
import { desktopBrowserPartition } from "../dist/main/browser/manager.js";

test("browser network permits explicit loopback previews, blocks application origin and private destinations", async () => {
  const options = { allowedLoopbackOrigin: "http://localhost:3000", forbiddenOrigins: ["http://127.0.0.1:17891"], resolveHost: async () => ["93.184.215.14"] };
  await assertBrowserNetworkUrl("http://localhost:3000/", options);
  await assertBrowserNetworkUrl("ws://localhost:3000/hmr", options);
  await assertBrowserNetworkUrl("https://example.com/", options);
  for (const url of ["http://localhost:3001/", "http://127.0.0.1:17891/health", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/"]) {
    await assert.rejects(assertBrowserNetworkUrl(url, options));
  }
  await assert.rejects(assertBrowserNetworkUrl("https://rebound.example/", { ...options, resolveHost: async () => ["93.184.215.14", "10.0.0.1"] }));
  for (const host of ["localhost", "[::1]", "127.0.0.2"]) {
    const origin = `http://${host}:17891`;
    await assert.rejects(assertBrowserNetworkUrl(`${origin}/health`, { ...options, allowedLoopbackOrigin: origin }), /browser_application_origin_forbidden/u);
  }
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::1", "fe80::1", "fc00::1"]) assert.equal(isBrowserPublicAddress(address), false, address);
});

test("browser profile names are stable, path-free and workspace-isolated", () => {
  assert.equal(desktopBrowserPartition("/w/a"), desktopBrowserPartition("/w/a"));
  assert.notEqual(desktopBrowserPartition("/w/a"), desktopBrowserPartition("/w/b"));
  assert.match(desktopBrowserPartition("/w/a"), /^persist:ling-browser-[a-f0-9]{32}$/u);
});

test("browser bridge rejects pages, subframes, detached frames and navigated owners", () => {
  const frame = { detached: false, url: "file:///app/index.html#/chat" };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  assert.doesNotThrow(() => assertBrowserIpcSender(event, window, "file:///app/index.html"));
  assert.throws(() => assertBrowserIpcSender({ ...event, sender: {} } as IpcMainInvokeEvent, window, "file:///app/index.html"));
  assert.throws(() => assertBrowserIpcSender({ ...event, senderFrame: { ...frame } } as IpcMainInvokeEvent, window, "file:///app/index.html"));
  frame.detached = true; assert.throws(() => assertBrowserIpcSender(event, window, "file:///app/index.html")); frame.detached = false;
  frame.url = "https://example.com"; assert.throws(() => assertBrowserIpcSender(event, window, "file:///app/index.html"));
});

test("browser IPC parsers enforce typed payloads and bounded geometry", () => {
  const workspace = { workspaceCwd: "/w", scope: { surface: "normal_conversation", ownerId: "a" } };
  assert.throws(() => parseBrowserUserAction({ ...workspace, action: "evaluate", script: "1" }));
  assert.throws(() => parseBrowserUserAction({ ...workspace, action: "open", url: "https://example.com", bridgeToken: "forged" }));
  assert.throws(() => parseBrowserViewport({ ...workspace, generation: 1, visible: true, bounds: { x: 0, y: 0, width: Infinity, height: 1 } }));
  assert.equal(parseBrowserUserAction({ ...workspace, action: "open", url: "http://localhost:3000" }).action, "open");
  assert.deepEqual(parseBrowserSettingsAction({ workspaceCwd: "/w", action: "download_preferences", askBeforeDownload: true }),
    { workspaceCwd: "/w", action: "download_preferences", askBeforeDownload: true });
  for (const action of [
    { workspaceCwd: "/w", action: "open", url: "https://example.com" },
    { workspaceCwd: "/w", action: "clear_data", cookies: true, cache: false, storage: false, history: false, scope: workspace.scope },
    { workspaceCwd: "/w", action: "device_permission", rule: { origin: "https://example.com/path", permission: "camera", decision: "allow" } },
  ]) assert.throws(() => parseBrowserSettingsAction(action));
});
