import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  HostLocalPreviewManager,
  HostPreviewError,
  isAllowedHostPreviewResourceUrl,
} from "../dist/main/host-capabilities/preview-manager.js";

test("HTML preview is isolated, non-persistent, network-denied and workspace-confined", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-host-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const htmlPath = join(root, "index.html");
  await writeFile(htmlPath, "<!doctype html><script>document.body.textContent='ready'</script>");
  const realRoot = await realpath(root);
  const created = [];
  const manager = new HostLocalPreviewManager({
    desktopInstanceId: "desktop/unsafe",
    createWindow: (options) => {
      const window = fakeWindow(options);
      created.push(window);
      return window;
    },
  });
  const launch = await manager.launch(command(root, htmlPath, "index.html", "interactive_html"));
  const window = created[0];

  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.partition.startsWith("persist:"), false);
  assert.match(window.options.webPreferences.partition, /^ling-host-preview-desktop-unsafe-1$/u);
  assert.equal(window.loadedFile, await realpath(htmlPath));
  assert.equal(window.shown, true);
  assert.equal(window.session.permissionCheck(), false);
  let permission;
  window.session.permissionRequest(undefined, undefined, (value) => { permission = value; });
  assert.equal(permission, false);
  assert.equal(window.windowOpen({ url: "https://example.com" }).action, "deny");
  assert.equal(window.requestAllowed("https://example.com/app.js"), false);
  assert.equal(window.requestAllowed(pathToFileURL(join(realRoot, "asset.js")).href), true);
  assert.equal(window.requestAllowed(pathToFileURL(join(realRoot, "..", "secret.txt")).href), false);

  launch.close();
  assert.equal(window.destroyed, true);
  await manager.close();
});

test("source preview renders escaped read-only text instead of executing file contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-host-source-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "notes.ts");
  await writeFile(sourcePath, "<script>alert('unsafe')</script>\nconst ready = true;");
  const created = [];
  const manager = new HostLocalPreviewManager({
    desktopInstanceId: "desktop-source",
    createWindow: (options) => {
      const window = fakeWindow(options);
      created.push(window);
      return window;
    },
  });
  await manager.launch(command(root, sourcePath, "notes.ts", "read_only_text"));
  const documentUrl = created[0].loadedUrl;
  const decoded = decodeURIComponent(documentUrl.slice(documentUrl.indexOf(",") + 1));
  assert.match(decoded, /read only/u);
  assert.match(decoded, /&lt;script&gt;alert\(&#39;unsafe&#39;\)&lt;\/script&gt;/u);
  assert.doesNotMatch(decoded, /<script>alert/u);
  await manager.close();
});

test("preview re-resolves symlinks and rejects targets outside the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-host-preview-root-"));
  const outside = await mkdtemp(join(tmpdir(), "ling-host-preview-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const secret = join(outside, "secret.html");
  const link = join(root, "index.html");
  await writeFile(secret, "secret");
  await symlink(secret, link);
  const manager = new HostLocalPreviewManager({
    desktopInstanceId: "desktop-symlink",
    createWindow: () => { throw new Error("window must not be created"); },
  });
  await assert.rejects(
    manager.launch(command(root, link, "index.html", "interactive_html")),
    (error) => error instanceof HostPreviewError && error.code === "host_preview_target_outside_workspace",
  );
  await manager.close();
});

test("resource policy allows only data/about and local files beneath the workspace", () => {
  assert.equal(isAllowedHostPreviewResourceUrl("about:blank", "/tmp/workspace"), true);
  assert.equal(isAllowedHostPreviewResourceUrl("data:text/plain,hello", "/tmp/workspace"), true);
  assert.equal(isAllowedHostPreviewResourceUrl("http://127.0.0.1/private", "/tmp/workspace"), false);
  assert.equal(isAllowedHostPreviewResourceUrl("file:///tmp/workspace/a.css", "/tmp/workspace"), true);
  assert.equal(isAllowedHostPreviewResourceUrl("file:///tmp/workspace-other/a.css", "/tmp/workspace"), false);
});

function command(workspaceRoot, absolutePath, path, presentation) {
  return {
    protocol: "ling-host-capability-bridge/v1",
    id: "command-1",
    capabilityId: "host.open_local_target",
    path,
    absolutePath,
    workspaceRoot,
    presentation,
    runId: "run-1",
    attemptId: "attempt-1",
    toolCallId: "tool-1",
    approvalId: "approval-1",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "idempotency-1",
  };
}

function fakeWindow(options) {
  const once = new Map();
  const listeners = new Map();
  let owner;
  const session = {
    permissionCheck: undefined,
    permissionRequest: undefined,
    beforeRequest: undefined,
    setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
    setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
    on(event, listener) { listeners.set(`session:${event}`, listener); return this; },
    webRequest: { onBeforeRequest(_filter, listener) { session.beforeRequest = listener; } },
    async clearStorageData() {},
  };
  owner = {
    options,
    session,
    shown: false,
    destroyed: false,
    loadedFile: undefined,
    loadedUrl: undefined,
    windowOpen: undefined,
    webContents: {
      session,
      on(event, listener) { listeners.set(event, listener); return this; },
      setWindowOpenHandler(handler) { owner.windowOpen = handler; },
    },
    once(event, listener) { once.set(event, listener); return this; },
    async loadFile(path) { this.loadedFile = path; once.get("ready-to-show")?.(); },
    async loadURL(url) { this.loadedUrl = url; once.get("ready-to-show")?.(); },
    show() { this.shown = true; },
    destroy() { this.destroyed = true; once.get("closed")?.(); },
    isDestroyed() { return this.destroyed; },
    requestAllowed(url) {
      let allowed;
      session.beforeRequest({ url }, ({ cancel }) => { allowed = !cancel; });
      return allowed;
    },
  };
  return owner;
}
