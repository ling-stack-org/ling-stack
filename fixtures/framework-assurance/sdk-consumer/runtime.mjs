import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@ling-stack/plugin-sdk";
import * as contracts from "@ling-stack/contracts";
import * as api from "@ling-stack/api-client";
import * as localization from "@ling-stack/localization";
import continuity from "@ling-stack/contracts/fixtures/channel-conversation-continuity-v2.json" with { type: "json" };

const tests = [];
const resolutions = [];
const cwd = "/sdk-consumer/work space";
const baseUrl = "https://daemon.invalid";
const token = "fixture-route-token";
globalThis.fetch = async () => { throw new Error("Unexpected real fetch: consumer tests require an explicit mock."); };

async function exercise(id, fn) {
  try { await fn(); tests.push({ id, passed: true }); }
  catch (error) {
    tests.push({ id, passed: false, error: `${error.name}: ${error.message}` });
  }
}

function extension(kind, id = `${kind}:fixture`) {
  return { id, name: "Consumer fixture", version: "0.1.0", kind, trustLevel: "internal", capabilities: ["read"] };
}

function packageManifest(overrides = {}) {
  return {
    id: "bundled:consumer-fixture", displayName: "Consumer fixture", version: "0.1.0",
    lingInterfaceVersion: "1", sourceKind: "bundled", trustLevel: "internal",
    trustSummary: "Metadata only; no execution authority is granted.",
    contributions: [{ kind: "mcp-server", id: "mcp:fixture", path: "./mcp-server.json" }],
    requiredSecrets: [{ ref: "FIXTURE_SECRET_REF", label: "Reference only" }],
    defaultApprovals: [{ contributionId: "mcp:fixture", decision: "ask" }],
    healthChecks: [{ id: "manifest", label: "Manifest", kind: "descriptor" }],
    ...overrides,
  };
}

function runner(id = "runner:fixture") {
  return {
    manifest: extension("runner", id), runnerId: "fixture", supportedTools: ["read"],
    supportedProviderApis: ["openai-completions"], eventTypes: ["run_start", "run_end"],
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: [] },
  };
}

function tool(id = "tool:fixture") {
  return { manifest: extension("tool", id), toolName: "fixture", sideEffectLevel: "read", defaultApproval: "allow" };
}

function mockClient(respond, options = {}) {
  const calls = [];
  const client = new api.LingDaemonClient({
    baseUrl, computerUseRouteToken: token, ...options,
    fetch: async (url, init = {}) => {
      const call = { url: String(url), init, headers: new Headers(init.headers) };
      calls.push(call);
      return respond(call, calls.length);
    },
  });
  return { client, calls };
}

function assertUnscoped(call) {
  assert.equal(call.headers.get(contracts.COMPUTER_USE_ROUTE_TOKEN_HEADER), null);
  assert.equal(call.url.includes(token), false);
  assert.equal(String(call.init.body).includes(token), false);
}

function rawStream() {
  const chunks = ["event: fixture\nda", "ta: {\"value\":", "1}\n\n"];
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  return { response, chunks, wasCancelled: () => cancelled };
}

async function assertRawChunks(received, stream) {
  assert.equal(received, stream.response);
  const reader = received.body.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  } finally { reader.releaseLock(); }
  assert.deepEqual(chunks, stream.chunks);
}

await exercise("public-bare-imports-and-json-export", async () => {
  assert.equal(typeof sdk.createLingExtensionRegistry, "function");
  assert.equal(typeof contracts.isRunEventType, "function");
  assert.equal(typeof api.LingDaemonClient, "function");
  assert.ok(Object.keys(localization).length > 0);
  assert.equal(contracts.isConversationContinuityGoldenFixtureV1(continuity), true);
  const catalog = await import("@ling-stack/localization/catalogs/en-US");
  assert.equal(catalog.catalog.locale, "en-US");
  for (const name of ["plugin-sdk", "contracts", "api-client", "localization"]) {
    const specifier = `@ling-stack/${name}`;
    const directory = path.join(process.cwd(), "node_modules", specifier);
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(await realpath(directory), directory);
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    assert.ok(resolved.startsWith(directory + path.sep));
    assert.equal(path.relative(directory, resolved).split(path.sep).includes("src"), false);
    resolutions.push({ specifier, resolved: path.relative(process.cwd(), resolved).split(path.sep).join("/"), workspaceSymlink: false });
  }
});

await exercise("private-deep-imports-are-not-exported", async () => {
  for (const name of ["plugin-sdk", "contracts", "api-client", "localization"]) {
    for (const privatePath of ["src/index.js", "dist/index.js"]) {
      await assert.rejects(import(`@ling-stack/${name}/${privatePath}`), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
    }
  }
});

await exercise("extension-manifest-current-nonempty-version-contract", () => {
  sdk.validateLingExtensionManifest(extension("tool"), "tool");
  sdk.validateLingExtensionManifest({ ...extension("tool"), version: "next" });
  assert.throws(() => sdk.validateLingExtensionManifest({ ...extension("tool"), version: "" }), /version/);
  assert.throws(() => sdk.validateLingExtensionManifest(extension("runner"), "tool"), /expected tool/);
  assert.throws(() => sdk.validateLingExtensionManifest({ ...extension("tool"), trustLevel: "external" }), /trust level/);
  assert.throws(() => sdk.validateLingExtensionManifest({ ...extension("tool"), capabilities: [""] }), /capabilities/);
  assert.throws(() => sdk.validateLingExtensionManifest({ ...extension("tool"), requiredApprovals: [{ decision: "allow", risk: "low" }] }), /approval decision/);
});

await exercise("package-manifest-interface-version-contributions-secrets-paths", () => {
  sdk.validateLingPluginPackageManifest(packageManifest());
  assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ version: "next" })), /version/);
  assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ lingInterfaceVersion: "99" })), /interface/);
  assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ contributions: [
    { kind: "mcp-server", id: "shared", path: "./one.json" },
    { kind: "skill-pack", id: "shared", path: "./skills" },
  ] })), /Duplicate/);
  assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ contributions: [{ kind: "hook", id: "hook", path: "./hook.js" }] })), /Unsupported/);
  for (const unsafePath of ["../outside.json", "/absolute.json", "C:\\outside.json", "./nested/../outside.json"]) {
    assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ contributions: [{ kind: "mcp-server", id: "mcp:fixture", path: unsafePath }] })), /relative|path segments/);
  }
  assert.throws(() => sdk.validateLingPluginPackageManifest(packageManifest({ requiredSecrets: [{ ref: "FIXTURE", label: "Reference", value: "fixture-not-a-credential" }] })), /secret value/);
});

await exercise("registry-kind-duplicate-lookups-and-frozen-snapshots", () => {
  const tools = sdk.createExtensionKindRegistry("tool");
  tools.register(tool());
  assert.equal(tools.get("tool:fixture").toolName, "fixture");
  assert.equal(tools.has("tool:fixture"), true);
  assert.equal(tools.has("missing"), false);
  assert.equal(Object.isFrozen(tools.list()), true);
  assert.throws(() => tools.list().push(tool("tool:other")), TypeError);
  assert.throws(() => tools.register(runner()), /expected tool/);
  const registry = sdk.createLingExtensionRegistry();
  registry.register(tool("shared:id"));
  assert.throws(() => registry.register(runner("shared:id")), /Duplicate extension id/);
  registry.runners.register(runner());
  assert.equal(registry.get("runner:fixture").runnerId, "fixture");
  assert.equal(registry.get("missing"), undefined);
  assert.equal(registry.has("shared:id"), true);
  assert.deepEqual(registry.listByKind("runner").map((value) => value.runnerId), ["fixture"]);
  assert.equal(registry.list().length, 2);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.listByKind("runner")), true);
});

await exercise("contracts-public-runtime-guards", () => {
  assert.equal(contracts.isRunEventType("run_start"), true);
  assert.equal(contracts.isRunEventType("imaginary_event"), false);
  assert.equal(contracts.isRunEventData("assistant_text_delta", { text: "fixture" }), true);
  assert.equal(contracts.isRunEventData("assistant_text_delta", { text: 42 }), false);
});

await exercise("json-public-endpoint-url-body-and-token-scope", async () => {
  const payload = { fixture: "response" };
  const { client, calls } = mockClient(() => Response.json(payload));
  assert.deepEqual(await client.getConversation(cwd, "thread/one"), payload);
  await client.createChannelTurn(cwd, "channel/one", { body: "fixture", requestAiReply: false });
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, "/conversations/thread%2Fone");
  assert.equal(first.searchParams.get("cwd"), cwd);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new URL(calls[1].url).pathname, "/channels/channel%2Fone/turns");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), { body: "fixture", requestAiReply: false });
  calls.forEach(assertUnscoped);
});

await exercise("json-http-message-code-and-fallback-are-not-fetch-errors", async () => {
  const { client, calls } = mockClient(() => Response.json({ error: "approval_invalid", message: "Fixture business failure" }, { status: 409 }));
  await assert.rejects(client.getConversation(cwd, "thread"), (error) => {
    assert.equal(error instanceof api.LingDaemonError, true);
    assert.equal(error instanceof api.LingDaemonTransportError, false);
    assert.equal(error.status, 409);
    assert.equal(error.code, "approval_invalid");
    assert.equal(error.message, "Fixture business failure");
    return true;
  });
  assert.equal(calls.length, 1);
  const fallback = mockClient(() => new Response("not-json", { status: 503, statusText: "Unavailable" }));
  await assert.rejects(fallback.client.getConversation(cwd, "thread"), (error) => error instanceof api.LingDaemonError && error.message === "503 Unavailable" && error.code === undefined);
});

await exercise("fetch-cause-no-retry-abort-identity-and-malformed-json", async () => {
  const cause = new TypeError("Fixture fetch failure");
  const failing = mockClient(() => { throw cause; });
  await assert.rejects(failing.client.getConversation(cwd, "thread"), (error) => error instanceof api.LingDaemonTransportError && error.phase === "fetch" && error.cause === cause && error.message === cause.message);
  assert.equal(failing.calls.length, 1);
  const abort = new DOMException("Fixture cancelled", "AbortError");
  const aborted = mockClient(() => { throw abort; });
  await assert.rejects(aborted.client.getConversation(cwd, "thread"), (error) => error === abort);
  assert.equal(aborted.calls.length, 1);
  const malformed = mockClient(() => new Response("{invalid", { status: 200 }));
  await assert.rejects(malformed.client.getConversation(cwd, "thread"), (error) => error instanceof SyntaxError && !(error instanceof api.LingDaemonTransportError) && !(error instanceof api.LingDaemonError));
  assert.equal(malformed.calls.length, 1);
});

await exercise("conversation-stream-raw-response-no-http-ok-check", async () => {
  const stream = rawStream();
  const { client, calls } = mockClient(() => stream.response);
  await assertRawChunks(await client.streamConversation(cwd, { schemaVersion: 2, message: "fixture" }), stream);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].headers.get("Accept"), null);
  assert.equal(calls[0].headers.get("Content-Type"), "application/json");
  assert.equal(calls[0].init.signal, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { schemaVersion: 2, message: "fixture" });
  assertUnscoped(calls[0]);
  const deniedResponse = Response.json({ error: "fixture_denied" }, { status: 403 });
  const denied = mockClient(() => deniedResponse);
  assert.equal(await denied.client.streamConversation(cwd, { message: "fixture" }), deniedResponse);
  assert.equal(denied.calls.length, 1);
});

await exercise("channel-workflow-and-control-plane-raw-stream-contracts", async () => {
  const entries = [
    { invoke: (client) => client.streamChannelTurn(cwd, "channel/one", { body: "fixture" }), pathname: "/channels/channel%2Fone/turns/stream", method: "POST" },
    { invoke: (client) => client.streamChannelWorkflowStep(cwd, "step/one", { mode: "create_and_run_task" }), pathname: "/workflow-steps/step%2Fone/start", method: "POST" },
    { invoke: (client) => client.streamControlPlaneEvents(cwd, { afterSeq: 7, domains: ["runs"] }), pathname: "/control-plane/stream", method: "GET", afterSeq: "7" },
  ];
  for (const entry of entries) {
    const stream = rawStream();
    const success = mockClient(() => stream.response);
    await assertRawChunks(await entry.invoke(success.client), stream);
    const call = success.calls[0];
    const url = new URL(call.url);
    assert.equal(url.pathname, entry.pathname);
    assert.equal(url.searchParams.get("cwd"), cwd);
    if (entry.afterSeq) assert.equal(url.searchParams.get("afterSeq"), entry.afterSeq);
    assert.equal(call.init.method, entry.method);
    assert.equal(call.headers.get("Accept"), "text/event-stream");
    assert.equal(call.init.signal, undefined);
    assertUnscoped(call);
    const denied = mockClient(() => Response.json({ error: "fixture_denied", message: "Fixture denied" }, { status: 403 }));
    await assert.rejects(entry.invoke(denied.client), (error) => error instanceof api.LingDaemonError && error.status === 403 && error.message === "Fixture denied" && error.code === undefined);
    assert.equal(denied.calls.length, 1);
  }
  const invalid = mockClient(() => { throw new Error("Invalid mode must not dispatch"); });
  await assert.rejects(invalid.client.streamChannelWorkflowStep(cwd, "step", { mode: "create_task" }), /create_and_run_task/);
  assert.equal(invalid.calls.length, 0);
});

await exercise("computer-use-scoped-token-validation-after-seq-and-signal", async () => {
  const stream = rawStream();
  const scoped = mockClient((call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith("/stream")) return stream.response;
    if (url.pathname.endsWith("/snapshot")) return Response.json({ cwd, projections: [], latestSeq: 0 });
    if (url.pathname.endsWith("/events")) return Response.json({ cwd, afterSeq: 3, latestSeq: 3, events: [] });
    if (url.pathname.endsWith("/stop")) return Response.json({
      sessionId: "session/one", accepted: true, acknowledged: false, auditId: "audit-fixture",
      projection: {
        sessionId: "session/one", conversationId: "thread/one", status: "running",
        target: { kind: "application", displayName: "Fixture app" },
        startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    return Response.json({ cwd, projections: [] });
  });
  await scoped.client.listComputerUsePreviews(cwd);
  await scoped.client.getComputerUsePreviewSnapshot(cwd);
  await scoped.client.listComputerUsePreviewEvents(cwd, 3, 10);
  const controller = new AbortController();
  await assertRawChunks(await scoped.client.streamComputerUsePreviews(cwd, 4, controller.signal), stream);
  await scoped.client.stopComputerUse(cwd, "session/one", { reason: "operator_requested" });
  assert.equal(scoped.calls.length, 5);
  for (const call of scoped.calls) {
    assert.ok(new URL(call.url).pathname.startsWith("/computer-use/"));
    assert.equal(call.headers.get(contracts.COMPUTER_USE_ROUTE_TOKEN_HEADER), token);
    assert.equal(call.headers.get("X-Ling-Desktop-Bridge-Token"), null);
    assert.equal(call.url.includes(token), false);
  }
  assert.equal(new URL(scoped.calls[3].url).searchParams.get("afterSeq"), "4");
  assert.equal(scoped.calls[3].headers.get("Accept"), "text/event-stream");
  assert.equal(scoped.calls[3].init.signal, controller.signal);
  assert.equal(new URL(scoped.calls[4].url).pathname, "/computer-use/sessions/session%2Fone/stop");
  assert.deepEqual(JSON.parse(scoped.calls[4].init.body), { reason: "operator_requested" });
  const browser = mockClient(() => Response.json({ cwd, projections: [] }), { computerUseRouteToken: undefined });
  await browser.client.listComputerUsePreviews(cwd);
  assert.equal(browser.calls[0].headers.get(contracts.COMPUTER_USE_ROUTE_TOKEN_HEADER), null);
  const invalid = mockClient(() => Response.json({ cwd: "/wrong-workspace", projections: [] }));
  await assert.rejects(invalid.client.listComputerUsePreviews(cwd), /computer_use_list_response_invalid/);
});

await exercise("computer-use-cancellation-and-stream-read-errors-remain-caller-owned", async () => {
  const controller = new AbortController();
  const aborted = mockClient((call) => new Promise((_resolve, reject) => {
    call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason), { once: true });
  }));
  const pending = aborted.client.streamComputerUsePreviews(cwd, 9, controller.signal);
  const reason = new DOMException("Fixture stop", "AbortError");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(aborted.calls.length, 1);
  const denied = mockClient(() => Response.json({ error: "fixture_denied", message: "Fixture denied" }, { status: 403 }));
  await assert.rejects(denied.client.streamComputerUsePreviews(cwd), (error) => error instanceof api.LingDaemonError && error.status === 403 && error.code === undefined);
  let cancelReason;
  const raw = new Response(new ReadableStream({ cancel(reason) { cancelReason = reason; } }));
  const cancellation = mockClient(() => raw);
  const received = await cancellation.client.streamComputerUsePreviews(cwd);
  await received.body.cancel("fixture-caller-cancel");
  assert.equal(cancelReason, "fixture-caller-cancel");
  assert.equal(cancellation.calls.length, 1);
  const readError = new Error("Fixture read failure");
  const broken = mockClient(() => new Response(new ReadableStream({ start(controller) { controller.error(readError); } })));
  const response = await broken.client.streamComputerUsePreviews(cwd);
  await assert.rejects(response.text(), (error) => error === readError);
  assert.equal(broken.calls.length, 1);
});

for (const entry of [
  { id: "conversation", invoke: (client) => client.streamConversation(cwd, { message: "fixture" }) },
  { id: "channel-turn", invoke: (client) => client.streamChannelTurn(cwd, "channel", { body: "fixture" }) },
  { id: "workflow-step", invoke: (client) => client.streamChannelWorkflowStep(cwd, "step", { mode: "create_and_run_task" }) },
  { id: "control-plane", invoke: (client) => client.streamControlPlaneEvents(cwd, { afterSeq: 7 }) },
  { id: "computer-use", invoke: (client) => client.streamComputerUsePreviews(cwd, 4) },
]) {
  await exercise(`raw-${entry.id}-fetch-errors-abort-and-caller-owned-body`, async () => {
    const cause = new TypeError(`Fixture ${entry.id} fetch failure`);
    const failed = mockClient(() => { throw cause; });
    await assert.rejects(entry.invoke(failed.client), (error) => error instanceof api.LingDaemonTransportError && error.phase === "fetch" && error.cause === cause);
    assert.equal(failed.calls.length, 1);
    const abort = new DOMException(`Fixture ${entry.id} cancelled`, "AbortError");
    const aborted = mockClient(() => { throw abort; });
    await assert.rejects(entry.invoke(aborted.client), (error) => error === abort);
    assert.equal(aborted.calls.length, 1);
    let cancelReason;
    const body = new ReadableStream({ cancel(reason) { cancelReason = reason; } });
    const raw = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    const cancelled = mockClient(() => raw);
    const received = await entry.invoke(cancelled.client);
    assert.equal(received, raw);
    await received.body.cancel("fixture-caller-cancel");
    assert.equal(cancelReason, "fixture-caller-cancel");
    assert.equal(cancelled.calls.length, 1);
    const readError = new Error(`Fixture ${entry.id} read failure`);
    const broken = mockClient(() => new Response(new ReadableStream({ start(controller) { controller.error(readError); } })));
    await assert.rejects((await entry.invoke(broken.client)).text(), (error) => error === readError && !(error instanceof api.LingDaemonTransportError));
    assert.equal(broken.calls.length, 1);
  });
}

await exercise("management-client-is-a-separate-local-authority-and-error-contract", async () => {
  assert.throws(() => new api.ExecutionEngineManagementClient({ baseUrl }), (error) => error instanceof api.LingDaemonError && error.code === "engine_host_must_be_local");
  let calls = 0;
  const cause = new TypeError("Fixture management fetch failure");
  const client = new api.ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:1", credentials: () => ({ token: "fixture-management", csrfToken: "fixture-csrf" }), fetch: async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get(contracts.COMPUTER_USE_ROUTE_TOKEN_HEADER), null);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    throw cause;
  } });
  await assert.rejects(client.listProfiles(), (error) => error === cause && !(error instanceof api.LingDaemonTransportError));
  assert.equal(calls, 1);
  const denied = new api.ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:1", credentials: () => ({ token: "fixture-management", csrfToken: "fixture-csrf" }), fetch: async () => Response.json({ error: "profile_fixture_denied", message: "Not the management message contract" }, { status: 409 }) });
  await assert.rejects(denied.listProfiles(), (error) => error instanceof api.LingDaemonError && error.code === "profile_fixture_denied" && error.message === "profile_fixture_denied");
});

const passed = tests.every((test) => test.passed);
process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "sdk_consumer_runtime", passed, tests, resolutions }) + "\n");
process.exitCode = passed ? 0 : 1;
