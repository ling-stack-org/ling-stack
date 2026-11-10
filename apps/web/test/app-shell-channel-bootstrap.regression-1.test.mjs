import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "../scripts/typescript-ast.mjs";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// Regression: E6-CHANNEL-BOOT — desktop health changes owner but no fresh sidebar read follows.
// Found by /qa on 2026-10-28
// Report: output/e6-20260928/channel-policy-cold-start-empty-channels-root-cause-20261028.md
// Value: protects=committed workspace hydration without stale publication; fails_when=owner change lacks a fresh read;
// why_new=existing pause tests call a stable domain directly, not Shell health and effect scheduling; seam=none;
// no_claim=actual Shell callbacks/domain with hook and API ports, not full React mounting or native GUI.
const appPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const { shell, startup } = withTypeScriptSourceFiles([appPath], files => {
  const source = files.get(appPath), effects = [], health = [], startup = [];
  visitTypeScriptNode(source, node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
      && node.arguments[0]?.getText(source).includes("refreshChannels(")) effects.push(node.getText(source));
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === "refreshHealth") health.push(node.getText(source));
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
      && node.arguments[0]?.getText(source).includes("refreshHealth(")) startup.push(node.getText(source));
  });
  assert.ok(effects.length > 0); assert.equal(health.length, 1); assert.equal(startup.length, 1);
  return {
    shell: stripTypeScriptTypes(`(() => { ${effects.join(";\n")}; ${health[0]}; return refreshHealth; })`, { mode: "transform" }),
    startup: stripTypeScriptTypes(`(() => { ${startup[0]} })`, { mode: "transform" }),
  };
}, { cwd: fileURLToPath(new URL("..", import.meta.url)) });
const workspacePath = "domains/workspace/use-workspace-domain.ts";
const observationPath = "shared/conversation/observation/daemon-observation.tsx";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function fixture(t, initial = {}) {
  const domainHooks = catalogHookPort(), shellHooks = catalogHookPort(), startupHooks = catalogHookPort(), requests = [], feedback = [];
  const source = await readFile(new URL(`../src/${workspacePath}`, import.meta.url), "utf8");
  const start = source.indexOf("import {\n"), end = source.indexOf('} from "../../api.js";', start);
  assert.ok(start >= 0 && end > start);
  const apiAnchor = source.slice(start, source.indexOf(";", end) + 1);
  const apiNames = apiAnchor.slice(apiAnchor.indexOf("{") + 1, apiAnchor.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
  const api = Object.fromEntries(apiNames.map(name => [name, async (cwd) => {
    if (name === "listChannels") { const pending = deferred(); requests.push({ cwd, ...pending }); return pending.promise; }
    if (name === "listAiCouncils") return { councils: [{ id: `council:${cwd}` }] };
    if (name === "getAiCouncilHealth") return { report: { cwd } };
    if (name === "listMemoryObjects") return { memories: [{ id: `memory:${cwd}` }] };
    if (name === "listUsedMemoryEvents") return { events: [{ id: `used:${cwd}` }] };
    throw new Error(`unexpected IO ${name}`);
  }]));
  const h = await catalogConsumerHarness(t, {
    exports: { [workspacePath]: ["useWorkspaceDomain"], [observationPath]: ["projectDaemonObservation", "liveDaemonObservation"] },
    transforms: {
      [workspacePath]: [
        { anchor: source.slice(0, source.indexOf(";") + 1), replace: key => `const { useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
        { anchor: apiAnchor, replace: key => `const { ${apiNames.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
      ],
      "lib/use-latest-request.ts": [{ anchor: 'import { useRef } from "react";', replace: key => `const { useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` }],
    }, ports: { hooks: domainHooks.hooks, api },
  });
  const healthRequests = [], resets = [], observationRef = { current: h.module.liveDaemonObservation };
  let cwd = initial.cwd ?? "", healthy = initial.healthy, paused = false;
  let baseUrl = "http://127.0.0.1:17928", observation = h.module.liveDaemonObservation, current, currentContext;
  const noop = async () => {};
  function render() {
    const status = paused ? { ownedByDesktop: true, state: "draining", baseUrl } : undefined;
    observation = h.module.projectDaemonObservation(observation, status, baseUrl, cwd);
    observationRef.current = observation;
    const domain = domainHooks.render(h.module.useWorkspaceDomain, { cwd, initialWorkspaceCwd: "", selectedChannelBranchId: "",
      translate: value => value, observation, clearFeedback() {}, reportFeedback: entry => feedback.push(entry) });
    const context = {
      useEffect: shellHooks.hooks.useEffect, activeView: "workspace", focusRevalidationToken: 0,
      settingsWorkspaceToolView: "", selectedChannelId: "", desktopHosted: true, form: { cwd },
      daemonHealthy: healthy, daemonObservation: observation, daemonObservationRef: observationRef,
      getDaemonHealth: async () => {
        if (!initial.deferHealth) return { ok: true, defaultWorkspaceCwd: "/isolated/channel-boot" };
        const pending = deferred(); healthRequests.push(pending); return pending.promise;
      },
      setDaemonHealthy: value => { healthy = value; }, setDaemonHealthRefreshing() {}, setDaemonFeatures() {},
      getViteDefaultWorkspaceCwd: () => "", readSavedWorkspaceCwd: () => "", clearSavedWorkspaceCwd() {},
      updateWorkspaceCwd: value => { resets.push(value); cwd = value; domain.actions.resetForCwd(value); },
      ...Object.fromEntries(["refreshProviderTemplates", "refreshProviders", "refreshAiTeammates", "refreshConversationThreads",
        "refreshSelectedConversation", "refreshRuns", "refreshApprovals", "refreshExternalWorkCiTriage", "refreshWorkItems",
        "refreshTasks", "refreshPlugins", "refreshMcp", "refreshApprovalPolicy", "refreshMediaJobs", "refreshAutomations",
        "refreshRuntimeSettings", "refreshExternalWorkStatus", "refreshRuntimeState", "loadStartupStatus"].map(name => [name, noop])),
      ...Object.fromEntries(["refreshChannels", "refreshAiCouncils", "refreshUsedMemoryAudit"].map(name => [name, domain.actions[name]])),
    };
    current = { domain, refreshHealth: shellHooks.render(runInNewContext(shell, context)) };
    currentContext = { ...context, refreshHealth: current.refreshHealth, useEffect: startupHooks.hooks.useEffect };
    return domain.state;
  }
  render();
  t.after(() => { domainHooks.unmount(); shellHooks.unmount(); startupHooks.unmount(); });
  return { requests, healthRequests, resets, feedback, render, state: () => render(),
    captureHealth: () => current.refreshHealth,
    async startup() { startupHooks.render(runInNewContext(startup, currentContext)); await startupHooks.flush(); await drain(); },
    error: () => { render(); return current.domain.error; }, health: () => current.refreshHealth(),
    async flush() { await shellHooks.flush(); await drain(); },
    change(next) {
      if (next.cwd !== undefined && next.cwd !== cwd) { current.domain.actions.resetForCwd(next.cwd); cwd = next.cwd; }
      if (next.healthy !== undefined) healthy = next.healthy;
      if (next.paused !== undefined) paused = next.paused;
      if (next.baseUrl !== undefined) baseUrl = next.baseUrl;
      return render();
    },
    async finish(request, id) { request.resolve({ channels: [{ id }], branches: [] }); await drain(); return render(); },
  };
}

test("desktop empty cwd commits health owner then hydrates channels without navigation or focus", async t => {
  const f = await fixture(t); await f.flush(); assert.equal(f.requests.length, 0);
  await f.health(); f.render(); await f.flush();
  for (const request of f.requests) await f.finish(request, "existing-channel");
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["existing-channel"]);
  assert.equal(f.requests.length, 1, "health must not launch an old-render request as a second owner");
  assert.equal(f.state().channelsLoading, false);
  assert.equal(f.state().aiCouncils[0].id, "council:/isolated/channel-boot");
  assert.equal(f.state().memoryObjects[0].id, "memory:/isolated/channel-boot");
  f.render(); await f.flush(); assert.equal(f.requests.length, 1, "stable renders do not poll");
});

test("pause defers hydration and resume re-reads, rejecting the pre-pause response", async t => {
  const f = await fixture(t, { cwd: "/isolated/a", healthy: true }); await f.flush();
  const old = f.requests.at(-1); assert.ok(old);
  f.change({ paused: true }); await f.flush(); const count = f.requests.length;
  f.change({ paused: false }); await f.flush(); assert.equal(f.requests.length, count + 1);
  await f.finish(f.requests.at(-1), "resumed"); await f.finish(old, "stale-before-pause");
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["resumed"]);
});

for (const change of [{ cwd: "/isolated/b" }, { baseUrl: "http://127.0.0.1:17929" }]) {
  test(`fresh sidebar hydration after ${Object.keys(change)[0]} change rejects the old owner`, async t => {
    const f = await fixture(t, { cwd: "/isolated/a", healthy: true }); await f.flush();
    const old = f.requests.at(-1), count = f.requests.length;
    f.change(change); await f.flush(); assert.equal(f.requests.length, count + 1);
    await f.finish(f.requests.at(-1), "new-owner"); await f.finish(old, "stale-owner");
    assert.deepEqual(f.state().channels.map(channel => channel.id), ["new-owner"]);
    assert.equal(f.state().channelsLoading, false);
  });
}

test("current owner HTTP error remains an error rather than a successful empty channel list", async t => {
  const f = await fixture(t); await f.flush(); await f.health(); f.render(); await f.flush();
  for (const request of f.requests) request.reject(new Error("HTTP 403 channel list denied"));
  await drain();
  assert.equal(f.error().message, "HTTP 403 channel list denied");
  assert.equal(f.state().channelsLoading, false);
  assert.equal(f.feedback.at(-1).workspaceCwd, "/isolated/channel-boot");
});

test("a delayed duplicate startup health response cannot clear an already hydrated owner", async t => {
  const f = await fixture(t, { deferHealth: true }); await f.flush();
  const first = f.health(), second = f.health();
  assert.equal(f.healthRequests.length, 2);
  f.healthRequests[0].resolve({ ok: true, defaultWorkspaceCwd: "/isolated/channel-boot" });
  await first; f.render(); await f.flush();
  await f.finish(f.requests.at(-1), "existing-channel");
  f.healthRequests[1].resolve({ ok: true, defaultWorkspaceCwd: "/isolated/channel-boot" });
  await second; f.render(); await f.flush();
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["existing-channel"]);
  assert.deepEqual(f.resets, ["/isolated/channel-boot"]);
  assert.equal(f.requests.length, 1, "late duplicate must not clear state or need compensating polling");
});

test("a startup callback invoked after owner commit compares the current cwd, not its old closure", async t => {
  const f = await fixture(t); await f.flush();
  const staleCallback = f.captureHealth();
  await f.health(); f.render(); await f.flush();
  await f.finish(f.requests.at(-1), "existing-channel");
  await staleCallback(); f.render(); await f.flush();
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["existing-channel"]);
  assert.equal(f.resets.length, 1);
});

test("health captured for the previous workspace cannot restore it after a workspace switch", async t => {
  const f = await fixture(t, { cwd: "/isolated/a", healthy: true, deferHealth: true }); await f.flush();
  const pending = f.health();
  f.change({ cwd: "/isolated/b" }); await f.flush();
  await f.finish(f.requests.at(-1), "workspace-b");
  f.healthRequests[0].resolve({ ok: true, defaultWorkspaceCwd: "/isolated/a" }); await pending;
  f.render(); await f.flush();
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["workspace-b"]);
  assert.deepEqual(f.resets, []);
});

test("startup invalidated by Host pause obtains a fresh health owner after resume", async t => {
  const f = await fixture(t, { deferHealth: true }); await f.flush(); await f.startup();
  assert.equal(f.healthRequests.length, 1);
  f.change({ paused: true }); await f.startup(); assert.equal(f.healthRequests.length, 1);
  f.change({ paused: false }); await f.startup(); assert.equal(f.healthRequests.length, 2);
  f.healthRequests[0].resolve({ ok: true, defaultWorkspaceCwd: "/isolated/stale" });
  await drain(); f.render(); await f.flush();
  assert.equal(f.resets.length, 0); assert.equal(f.requests.length, 0);
  f.healthRequests[1].resolve({ ok: true, defaultWorkspaceCwd: "/isolated/channel-boot" });
  await drain(); f.render(); await f.flush();
  await f.finish(f.requests.at(-1), "resumed-channel");
  await f.startup(); assert.equal(f.healthRequests.length, 2, "healthy cwd commit does not trigger a new default application");
  assert.deepEqual(f.state().channels.map(channel => channel.id), ["resumed-channel"]);
});
