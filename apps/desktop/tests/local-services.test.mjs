import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import test from "node:test";
import { registerLocalServiceIpc } from "../dist/main/local-services.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";
import { createDesktopLocalServiceFetch, readDesktopLocalServiceRequest } from "../dist/shared/local-service-capabilities.js";

const documentUrl = "file:///fixture/web/index.html";
const baseUrl = "http://127.0.0.1:17891";
const request = { method: "GET", path: "/notifications?since=fixture" };

function fixture(fetchImpl = async () => new Response('{"ok":true}')) {
  const handlers = new Map();
  const frame = { url: documentUrl, detached: false };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const window = { webContents, isDestroyed: () => false };
  const calls = [];
  const event = { sender: webContents, senderFrame: frame };
  const input = {
    ipcMainImpl: { handle: (key, handler) => handlers.set(key, handler), removeHandler: (key) => handlers.delete(key) },
    getMainWindow: () => window, trustedDocumentUrl: documentUrl, baseUrl,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); },
  };
  return { handlers, frame, window, webContents, calls, event, input };
}

function register(f) {
  const unregister = registerLocalServiceIpc(f.input);
  return { unregister, invoke: (...args) => f.handlers.get(DESKTOP_IPC_CHANNELS.localServiceRequest)(...args) };
}

test("local service IPC uses the fixed Main URL and returns only status and bounded body", async () => {
  const f = fixture(async () => new Response('{"ok":true}', { status: 201, headers: { "X-Native-Secret": "fixture-token" } }));
  const { invoke, unregister } = register(f);
  const body = '{"label":"fixture"}';
  assert.deepEqual(await invoke(f.event, { method: "POST", path: "/im-destinations", body }), { status: 201, body: '{"ok":true}' });
  assert.equal(f.handlers.size, 1);
  const [url, init] = f.calls[0];
  assert.equal(url, `${baseUrl}/im-destinations`);
  assert.deepEqual(init.headers, { Accept: "application/json", "Content-Type": "application/json" });
  assert.equal(init.method, "POST");
  assert.equal(init.body, body);
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(Object.keys(init).some((key) => /token|auth|url/iu.test(key)), false);
  unregister();
  assert.equal(f.handlers.size, 0);
});

test("the precise route, method and query allowlist retains existing local APIs", () => {
  for (const [method, path] of [
    ["GET", "/notifications"], ["GET", "/notifications/stream?since=2026-01-01T00%3A00%3A00Z"],
    ["GET", "/notifications/preferences"], ["PATCH", "/notifications/preferences"],
    ["GET", "/startup/status?cwd=%2Ffixture%2Fworkspace"], ["POST", "/startup/refresh?cwd=%2Ffixture"],
    ["GET", "/diagnostics/doctor?cwd=%2Ffixture"], ["GET", "/diagnostics/logs?lines=200"],
    ["GET", "/skills/marketplace/inspect?url=https%3A%2F%2Fexample.com%2Findex.json"],
    ["GET", "/im-destinations"], ["POST", "/im-destinations"],
    ["PATCH", "/im-destinations/fixture-1_A"], ["DELETE", "/im-destinations/fixture-1_A"],
    ["POST", "/im-destinations/fixture-1_A/test"],
  ]) assert.deepEqual(readDesktopLocalServiceRequest({ method, path }), { method, path });
});

test("invalid paths, methods, queries, bodies and extra authority fail before fetch", async () => {
  const f = fixture();
  const { invoke } = register(f);
  const invalid = [
    undefined, null, [], "GET", { ...request, url: "http://attacker.example" },
    { ...request, headers: { Authorization: "fixture" } }, { ...request, token: "fixture" },
    ...["//attacker.example/notifications", "http://127.0.0.1:17891/notifications", "/health", "/notifications/",
      "/notifications//preferences", "/notifications/../notifications", "/x/../notifications", "/%6eotifications",
      "/notifications%2fpreferences", "/notifications/%2e%2e/notifications", "/notifications\\preferences",
      "/notifications#fragment", "/notifications?since=one#fragment", "/notifications?cwd=%2Ftmp",
      "/notifications?since=a&since=b", "/notifications?%73ince=fixture", "/notifications?since=%00",
      "/notifications?since=a&", "/notifications?since=a&&", "/notifications?since=", "/notifications?since",
      "/im-destinations?since=a", "/im-destinations/foo/bar", "/im-destinations/foo%2Ftest", "/im-destinations/foo/test?cwd=a",
      "/startup/status?cwd=a&lines=20", "/diagnostics/logs?cwd=a", "/skills/marketplace/inspect?url=x&cwd=a",
    ].map((path) => ({ method: "GET", path })),
    ...["HEAD", "OPTIONS", "PUT", "get", "POST", undefined, null, 1].map((method) => ({ path: "/notifications", method })),
    { method: "GET", path: "/notifications", body: "{}" },
    ...[null, {}, new Uint8Array([1]), "{", "", '"' + "密".repeat(22_000) + '"'].map((body) => ({ method: "PATCH", path: "/notifications/preferences", body })),
    { method: "POST", path: "/skills/marketplace/inspect", body: '{"url":"https://example.com"}' },
  ];
  for (const value of invalid) await assert.rejects(invoke(f.event, value), /local_service_invalid_request/u, JSON.stringify(value)?.slice(0, 100));
  await assert.rejects(invoke(f.event), /local_service_invalid_request/u);
  await assert.rejects(invoke(f.event, request, "extra"), /local_service_invalid_request/u);
  assert.equal(f.calls.length, 0);
  const maxBody = '"' + "a".repeat(65_534) + '"';
  await invoke(f.event, { method: "PATCH", path: "/notifications/preferences", body: maxBody });
  await assert.rejects(invoke(f.event, { method: "PATCH", path: "/notifications/preferences", body: maxBody + " " }), /local_service_invalid_request/u);
});

test("foreign windows, child frames, detached frames and different documents have no local service authority", async () => {
  const f = fixture();
  const { invoke } = register(f);
  for (const event of [
    { ...f.event, sender: { ...f.webContents } }, { ...f.event, sender: { ...f.webContents, id: 2 } },
    { ...f.event, senderFrame: { ...f.frame } }, { ...f.event, senderFrame: undefined },
  ]) await assert.rejects(invoke(event, request), /local_service_forbidden/u);
  f.frame.detached = true;
  await assert.rejects(invoke(f.event, request), /local_service_forbidden/u);
  f.frame.detached = false;
  for (const url of ["https://attacker.example", "file:///fixture/other.html", `${documentUrl}?other-document=1`]) {
    f.frame.url = url;
    await assert.rejects(invoke(f.event, request), /local_service_forbidden/u);
  }
  f.frame.url = documentUrl;
  f.window.isDestroyed = () => true;
  await assert.rejects(invoke(f.event, request), /local_service_forbidden/u);
  f.window.isDestroyed = () => false;
  f.webContents.isDestroyed = () => true;
  await assert.rejects(invoke(f.event, request), /local_service_forbidden/u);
  assert.equal(f.calls.length, 0);
});

test("async responses recheck the current trusted main frame before returning data", async () => {
  for (const navigate of [
    (f) => { f.frame.url = "https://attacker.example"; },
    (f) => { f.webContents.mainFrame = { ...f.frame }; },
    (f) => { f.frame.detached = true; },
    (f) => { f.input.getMainWindow = () => undefined; },
  ]) {
    let f;
    f = fixture(async () => { navigate(f); return new Response("private-local-data"); });
    const { invoke } = register(f);
    await assert.rejects(invoke(f.event, request), { message: "local_service_forbidden" });
  }
  const f = fixture();
  f.frame.url = `${documentUrl}#/channel/fixture`;
  await assert.doesNotReject(register(f).invoke(f.event, request));
});

test("configured daemon URLs must be canonical loopback HTTP origins", () => {
  const credentialUrl = new URL(baseUrl);
  credentialUrl.username = "fixture-user";
  credentialUrl.password = "fixture-password";
  for (const value of ["https://attacker.example", "http://192.168.1.1:17891", "http://127.1:17891", "http://2130706433:17891",
    "http://127.0.0.1:17891/path", credentialUrl.href, `${baseUrl}?secret=x`, `${baseUrl}#fragment`, "invalid"]) {
    assert.throws(() => registerLocalServiceIpc({ ...fixture().input, baseUrl: value }), /local_service_invalid_base_url/u);
  }
  for (const value of [baseUrl, `${baseUrl}/`, "http://localhost:17891", "http://[::1]:17891"]) {
    assert.doesNotThrow(() => registerLocalServiceIpc({ ...fixture().input, baseUrl: value }));
  }
});

test("responses are streamed with a byte cap, including Content-Length and split UTF-8", async () => {
  const encoder = new TextEncoder();
  const utf8 = encoder.encode("你好");
  const ok = fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(utf8.slice(0, 2)); controller.enqueue(utf8.slice(2)); controller.close();
  } })));
  assert.deepEqual(await register(ok).invoke(ok.event, request), { status: 200, body: "你好" });
  const max = fixture(async () => new Response("a".repeat(2 * 1024 * 1024)));
  assert.equal((await register(max).invoke(max.event, request)).body.length, 2 * 1024 * 1024);
  for (const withHeader of [true, false]) {
    let cancelled = false;
    const f = fixture(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: withHeader ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {} }));
    await assert.rejects(register(f).invoke(f.event, request), { message: "local_service_response_too_large" });
    assert.equal(cancelled, true);
  }
});

test("network and redirect errors expose stable codes without native details", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("private native path /fixture/private token=fixture"); },
    async () => new Response("redirect-body", { status: 302, headers: { Location: "https://attacker.example" } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-stream-error")); } })),
  ]) {
    const f = fixture(fetchImpl);
    await assert.rejects(register(f).invoke(f.event, request), { message: "local_service_unavailable" });
  }
});

test("the fixed 30 second timeout covers fetch and response streaming", async (t) => {
  const controllers = [];
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => { timeouts.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal; });
  const pendingFetch = fixture(async () => new Promise(() => {}));
  const pending = register(pendingFetch).invoke(pendingFetch.event, request);
  controllers[0].abort();
  await assert.rejects(pending, { message: "local_service_timeout" });
  let cancelled = false;
  const stream = fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const streamed = register(stream).invoke(stream.event, request);
  await new Promise((resolve) => setImmediate(resolve));
  controllers[1].abort();
  await assert.rejects(streamed, { message: "local_service_timeout" });
  assert.equal(cancelled, true);
  assert.deepEqual(timeouts, [30_000, 30_000]);
});

test("Web API transport proxies only the permitted daemon services and leaves other fetches intact", async () => {
  const proxied = [];
  const fallback = [];
  const transport = createDesktopLocalServiceFetch({ baseUrl, localServices: { request: async (value) => {
    proxied.push(value); return { status: 409, body: '{"error":"fixture"}' };
  } }, fetch: async (...args) => { fallback.push(args); return new Response("fallback"); } });
  const init = { method: "PATCH", body: '{"globalEnabled":false}', headers: { "X-Renderer-Header": "never-forwarded" } };
  const response = await transport(`${baseUrl}/notifications/preferences`, init);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "fixture" });
  assert.deepEqual(proxied, [{ method: "PATCH", path: "/notifications/preferences", body: init.body }]);
  for (const url of [`${baseUrl}/channels`, "https://attacker.example/notifications", `${baseUrl}/notifications-unknown`]) {
    assert.equal(await (await transport(url, init)).text(), "fallback");
  }
  assert.deepEqual(fallback.map(([url, options]) => [url, options === init]), [
    [`${baseUrl}/channels`, true], ["https://attacker.example/notifications", true], [`${baseUrl}/notifications-unknown`, true],
  ]);
  await assert.rejects(transport(`${baseUrl}/notifications?cwd=invalid`), /local_service_invalid_request/u);
  await assert.rejects(transport(`${baseUrl}/notifications`, { method: "POST" }), /local_service_invalid_request/u);
  assert.equal(proxied.length, 1);
});

test("the actual preload rejects unlisted requests before invoking Main", async () => {
  const bundle = await build({ entryPoints: [new URL("../preload/main-window.ts", import.meta.url).pathname],
    write: false, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  let desktop;
  const calls = [];
  runInNewContext(bundle.outputFiles[0].text, {
    require: (name) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, "lingDesktop"); desktop = value; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return { status: 200, body: "{}" }; } } };
    }, process: { argv: [], platform: "linux" }, URL, TextEncoder,
  });
  await assert.rejects(desktop.localServices.request({ method: "POST", path: "/notifications" }), /local_service_invalid_request/u);
  await assert.rejects(desktop.localServices.request({ ...request, headers: { Authorization: "fixture" } }), /local_service_invalid_request/u);
  assert.equal(calls.length, 0);
  await desktop.localServices.request(request);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[DESKTOP_IPC_CHANNELS.localServiceRequest, request]]);
});

test("the actual Web API client installs the selective Desktop transport", async () => {
  const bundle = await build({ entryPoints: [new URL("../../web/src/api/client.ts", import.meta.url).pathname],
    write: false, bundle: true, platform: "browser", format: "cjs", define: { "import.meta.env": "{}" }, logLevel: "silent" });
  const calls = [];
  const fallback = [];
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, URL, TextEncoder, Response, Headers,
    window: { lingDesktop: { daemonBaseUrl: baseUrl, localServices: { request: async (value) => {
      calls.push(value); return { status: 200, body: '{"schemaVersion":1,"notifications":[]}' };
    } } } },
    fetch: async (...args) => { fallback.push(args); return new Response('{"ok":true}'); },
  });
  await module.exports.daemonClient.listNotifications("fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ method: "GET", path: "/notifications?since=fixture" }]);
  assert.equal((await module.exports.daemonClient.getHealth()).ok, true);
  assert.equal(fallback[0][0], `${baseUrl}/health`);
});
