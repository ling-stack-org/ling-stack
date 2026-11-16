import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

test("signed HTTP events execute a real Pi Run once and deliver only to explicitly bound destinations", { timeout: 40_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-event-integration-"))), cwd = join(root, "workspace");
  await mkdir(cwd);
  const previousHome = process.env.LING_STACK_HOME; process.env.LING_STACK_HOME = join(root, "user");
  const provider = await startLoopbackPiProvider(() => ({ text: "Issue handled with verified result" }));
  const originalFetch = globalThis.fetch;
  const sends: { headers: Headers; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://hooks.slack.com/")) {
      sends.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    }
    return originalFetch(input, init);
  });
  let store: RunStore | undefined;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken: "event-fixture-token", defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: "enforce" } },
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
  }, { storeFactory: path => { store = createSqliteRunStore(path); return store; },
    chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
    secretResolver: { status: ref => ({ ref, kind: "env", configured: true }), resolve: ref => ({ configured: true,
      value: ref === "env:EVENT_SIGNING_KEY" ? "fixture-signing-key" : ref === "env:EVENT_DESTINATION" ? "https://hooks.slack.com/services/T/B/test" : undefined }) },
  });
  t.after(async () => { try { await daemon.stop(); await provider.close(); }
    finally { if (previousHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = previousHome;
      await rm(root, { recursive: true, force: true }); } });
  await daemon.start(); assert.ok(store); const owned = store;
  const address = daemon.server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const api = async (path: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: "Bearer event-fixture-token", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as Record<string, any>;
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`); return result;
  };
  const preset = owned.createProviderPreset({ kind: "glm", displayName: "Event loopback", providerId: "event-loopback", model: "static-tools",
    api: "openai-completions", baseUrl: provider.baseUrl, authHeader: false, reasoning: false, capabilities: ["chat"], enabled: true }, new Date().toISOString());
  const automation = (await api("/automations", { kind: "custom_prompt", title: "Handle issue", target: { scope: "workspace", workspaceId: DEFAULT_WORKSPACE_ID, cwd },
    trigger: { type: "manual" }, promptTemplate: { templateVersion: 1, promptMarkdown: "Handle the authenticated issue", contextSelectors: [] },
    executionPolicy: { providerPresetId: preset.id, allowedTools: ["read"], approvalProfile: { mode: "none" } } })).automation;
  const destination = (await api("/im-destinations", { label: "Bound sink", provider: "slack", webhookRef: "env:EVENT_DESTINATION" })).destination;
  await api("/im-destinations", { label: "Unbound sink", provider: "slack", webhookRef: "env:EVENT_DESTINATION" });
  await api("/automation-event-sources", { source: { id: "signed-issues", label: "Business issues", adapter: "business", enabled: true,
    secretRefs: ["env:EVENT_SIGNING_KEY"], rules: [{ automationId: automation.id, types: ["issue.opened"], destinationIds: [destination.id] }] } });
  const timestamp = new Date().toISOString(), body = JSON.stringify({ issue: "Fix the event fixture", token: "private-fixture-value" });
  const signature = `sha256=${createHmac("sha256", "fixture-signing-key").update(`${timestamp}.fixture-issue.issue.opened.${body}`).digest("hex")}`;
  const ingress = (changes: Record<string, string> = {}) => fetch(`${base}/automation-event-sources/signed-issues/events?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json", "x-ling-event-id": "fixture-issue", "x-ling-event-type": "issue.opened",
      "x-ling-event-timestamp": timestamp, "x-ling-signature-256": signature, ...changes }, body });
  assert.equal((await ingress({ "x-ling-event-type": "issue.closed" })).status, 401);
  assert.equal(owned.listAutomationEvents().length, 0);
  assert.equal((await fetch(`${base}/automation-events?cwd=${encodeURIComponent(cwd)}`)).status, 401);
  assert.equal((await ingress()).status, 202);
  assert.equal((await ingress()).status, 200);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && owned.listAutomationDeliveries()[0]?.status !== "delivered") await delay(25);
  const dispatch = owned.listAutomationEventDispatches()[0]; assert.equal(dispatch?.status, "linked", JSON.stringify(dispatch));
  const runs = owned.listAutomationRuns({ automationId: automation.id }); assert.equal(runs.length, 1);
  const run = owned.getRun(runs[0].runId!); assert.equal(run?.status, "succeeded", JSON.stringify(run));
  assert.equal(run?.continuationReason, undefined); assert.ok(run?.workUnitId);
  assert.equal(provider.requests.length, 1); assert.match(JSON.stringify(provider.requests[0]), /Fix the event fixture/);
  assert.doesNotMatch(JSON.stringify(owned.listAutomationEvents()), /private-fixture-value/);
  assert.equal(owned.listAutomationDeliveries()[0]?.status, "delivered"); assert.equal(sends.length, 1);
  assert.equal(sends[0].headers.get("idempotency-key"), owned.listAutomationDeliveries()[0].id);
  assert.match(sends[0].body, /Issue handled with verified result/);
});
