import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium } from "@playwright/test";

// Regression: C03-PANEL-SCOPE — late channel reads must not replace another viewport.
// Actual workspace Hook, React state and request guard; only HTTP is synthetic.
// Value: protects=selected-channel panel ownership; fails_when=old reads publish after navigation;
// why_new=stream-scope tests stub panel refreshes; seam=none; no_claim=packaged GUI.
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const domainPath = fileURLToPath(new URL("../src/domains/workspace/use-workspace-domain.ts", import.meta.url));
const apiNames = readFileSync(domainPath, "utf8").match(/import\s*\{([^{}]*)\}\s*from "\.\.\/\.\.\/api\.js";/u)[1]
  .split(",").map(name => name.trim()).filter(Boolean);
const { build } = createRequire(new URL("../../desktop/package.json", import.meta.url))("esbuild");
let browser, server, baseUrl;

before(async () => {
  const built = await build({
    stdin: { contents: harnessSource(), resolveDir: webRoot, loader: "tsx", sourcefile: "workspace-panel-scope-fixture.tsx" },
    bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false, logLevel: "silent",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "workspace-panel-http", setup(plugin) {
      plugin.onResolve({ filter: /^react$/ }, args => args.importer === domainPath
        ? { path: "panel-hooks", namespace: "fixture" } : undefined);
      plugin.onResolve({ filter: /^\.\.\/\.\.\/api\.js$/ }, args => args.importer === domainPath
        ? { path: "panel-http", namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        contents: args.path === "panel-hooks" ? `
          export { useRef } from "react";
          import { useState as realUseState } from "react";
          export function useState(initial) {
            const [state, setter] = realUseState(initial);
            return [state, update => window.qa.schedule(() => setter(update))];
          }
        ` : apiNames.map(name => `export const ${name} = (...args) => window.qa.http(${JSON.stringify(name)}, ...args);`).join("\n"),
        resolveDir: webRoot, loader: "js",
      }));
    } }],
  });
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<div id="root"></div><script>${built.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE
    ? { headless: true, executablePath: process.env.LING_WEB_TEST_CHROMIUM_EXECUTABLE }
    : { headless: true, channel: "chrome" });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

const methods = ["refreshChannelExecutionProposals", "refreshChannelFiles", "refreshChannelMessageRouteDecisions",
  "refreshChannelIntentDecisions", "refreshChannelProtocol", "refreshTasks", "refreshSelectedChannelCouncil",
  "refreshChannelGovernanceNotifications", "refreshChannelRunArtifacts", "refreshChannelExecutionActions",
  "refreshChannelActivityTransitions"];
async function fixture(run) {
  const page = await browser.newPage();
  try { await page.goto(baseUrl); await page.evaluate(() => window.qa.mount()); await run(page); }
  finally { await page.close(); }
}
const state = page => page.evaluate(() => window.qa.snapshot());

for (const method of methods) {
  test(`${method}: channel/workspace switches, including A-B-A, reject late success and failure`, () => fixture(async page => {
    for (const change of [{ channelId: "B" }, { cwd: "/workspace-B" }]) {
      for (const reject of [false, true]) {
        await page.evaluate(() => window.qa.mount());
        await page.evaluate(method => window.qa.start(method), method);
        assert.ok((await state(page)).requests > 0, "the real action issued HTTP");
        await page.evaluate(change => window.qa.change(change), change);
        await page.evaluate(() => window.qa.change({ cwd: "/workspace-A", channelId: "A" }));
        const before = await state(page);
        await page.evaluate(reject => window.qa.finish(reject), reject);
        assert.deepEqual((await state(page)).panels, before.panels);
        assert.deepEqual((await state(page)).feedback, before.feedback);
      }
    }
  }));

  test(`${method}: saved callbacks cannot launch an old-channel refresh in the new owner`, () => fixture(async page => {
    await page.evaluate(method => window.qa.save(method), method);
    await page.evaluate(() => window.qa.change({ channelId: "B" }));
    const before = await state(page);
    await page.evaluate(() => window.qa.startSaved());
    assert.equal((await state(page)).requests, before.requests);
    await page.evaluate(() => window.qa.finish());
    assert.deepEqual((await state(page)).panels, before.panels);
  }));

  test(`${method}: current-owner responses remain visible and same-key newest request wins`, () => fixture(async page => {
    await page.evaluate(method => window.qa.start(method), method);
    await page.evaluate(() => window.qa.finish(false, "current"));
    assert.ok(JSON.stringify((await state(page)).panels).includes("current"));
    await page.evaluate(method => window.qa.start(method), method);
    await page.evaluate(method => window.qa.start(method), method);
    await page.evaluate(() => window.qa.finishNewest("newest"));
    const newest = (await state(page)).panels;
    await page.evaluate(() => window.qa.finish(false, "superseded"));
    assert.deepEqual((await state(page)).panels, newest);
  }));
}

test("channel-wide panel reads remain valid when only the selected branch changes", () => fixture(async page => {
  await page.evaluate(() => window.qa.start("refreshChannelExecutionProposals"));
  await page.evaluate(() => window.qa.change({ branchId: "branch-B" }));
  await page.evaluate(() => window.qa.finish(false, "same-channel"));
  assert.ok(JSON.stringify((await state(page)).panels).includes("same-channel"));
}));

test("switching channels hides populated old panels before any new HTTP response", () => fixture(async page => {
  for (const method of methods) {
    await page.evaluate(method => window.qa.start(method), method);
    await page.evaluate(() => window.qa.finish(false, "visible-only-in-A"));
  }
  assert.ok(JSON.stringify((await state(page)).panels).includes("visible-only-in-A"));
  await page.evaluate(() => window.qa.change({ channelId: "B" }));
  assert.ok(!JSON.stringify((await state(page)).panels).includes("visible-only-in-A"));
  await page.evaluate(() => window.qa.start("refreshChannelFiles"));
  const before = (await state(page)).panels;
  assert.equal(before.filesLoading, true);
  await page.evaluate(() => window.qa.finish(false, "visible-only-in-B"));
  assert.ok(JSON.stringify((await state(page)).panels).includes("visible-only-in-B"));
}));

test("same-batch task navigation retains the target channel's injected task and explicit selection", () => fixture(async page => {
  for (const taskFirst of [true, false]) {
    await page.evaluate(() => window.qa.mount());
    await page.evaluate(() => window.qa.navigateTask("A", { inject: true, select: true }));
    await page.evaluate(taskFirst => window.qa.navigateTask("B", { taskFirst, inject: true, select: true }), taskFirst);
    const next = (await state(page)).panels;
    assert.deepEqual(next.tasks.map(task => task.id), ["task-B"]);
    assert.equal(next.selectedTaskId, "task-B");
  }
}));

test("same-batch settings return restores an explicit task before its HTTP row is available", () => fixture(async page => {
  await page.evaluate(() => window.qa.navigateTask("B", { select: true }));
  assert.equal((await state(page)).panels.selectedTaskId, "task-B");
  await page.evaluate(() => window.qa.change({ channelId: "A" }));
  assert.equal((await state(page)).panels.selectedTaskId, "", "ordinary navigation clears the old selection");
}));

test("task rows and implicit selection never survive a workspace change with the same channel ID", () => fixture(async page => {
  await page.evaluate(() => window.qa.navigateTask("A", { inject: true, select: true }));
  await page.evaluate(() => window.qa.change({ cwd: "/workspace-B" }));
  const next = (await state(page)).panels;
  assert.deepEqual(next.tasks, []);
  assert.equal(next.selectedTaskId, "");
}));

test("deferred panel state updaters recheck ownership when real React applies them", () => fixture(async page => {
  await page.evaluate(() => window.qa.start("refreshChannelFiles"));
  await page.evaluate(() => window.qa.holdSetters());
  await page.evaluate(() => window.qa.finish(false, "queued-old-owner"));
  assert.ok((await state(page)).queued > 0);
  await page.evaluate(() => window.qa.change({ channelId: "B" }));
  await page.evaluate(() => window.qa.change({ channelId: "A" }));
  const before = (await state(page)).panels;
  await page.evaluate(() => window.qa.releaseSetters());
  assert.deepEqual((await state(page)).panels, before);
}));

test("nonempty protocol workflow-step reads cannot publish after a switch during the second HTTP stage", () => fixture(async page => {
  await page.evaluate(() => window.qa.withWorkflow());
  await page.evaluate(() => window.qa.start("refreshChannelProtocol"));
  await page.evaluate(() => window.qa.settleBatch("first-stage"));
  assert.deepEqual((await state(page)).pendingNames, ["listChannelWorkflowSteps"]);
  await page.evaluate(() => window.qa.change({ channelId: "B" }));
  const before = (await state(page)).panels;
  await page.evaluate(() => window.qa.finish(false, "late-steps"));
  assert.deepEqual((await state(page)).panels, before);
  await page.evaluate(() => window.qa.start("refreshChannelProtocol"));
  await page.evaluate(() => window.qa.finish(false, "current-steps"));
  assert.equal((await state(page)).panels.steps[0].id, "current-steps");
}));

function harnessSource() {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { useWorkspaceDomain } from ${JSON.stringify(domainPath)};
    let root, api, view, requests, calls, pending, saved, feedback, hold = false, queued = [], workflow = false;
    const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
    function Harness() {
      api = useWorkspaceDomain({ cwd: view.cwd, initialWorkspaceCwd: view.cwd,
        selectedChannelBranchId: view.branchId ?? "", translate: value => value,
        reportFeedback: entry => feedback.push(entry), clearFeedback() {} });
      return null;
    }
    function response(name, tag) {
      const row = { id: tag, createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" };
      return { proposals: [row], attachments: [row], linkPreviews: [row], decisions: [row],
        tasks: [row], policy: row, effectiveCouncil: row, notifications: [row], artifacts: [row], actions: [row], transitions: [row],
        brief: row, handoffs: [row], contextSummaries: [row],
        workflows: workflow && name === "listChannelWorkflows" ? [row] : [],
        workflowSteps: workflow && name === "listChannelWorkflowSteps" ? [{ ...row, updatedAt: row.createdAt,
          channelId: view.channelId, workspaceId: "fixture", workflowId: "workflow", runId: "run", toParticipantId: "Engineer" }] : [], tag };
    }
    function args(method) {
      return ["refreshChannelRunArtifacts", "refreshChannelExecutionActions", "refreshChannelActivityTransitions"].includes(method)
        ? [view.cwd, view.channelId, [{ id: view.channelId + "-run", channelId: view.channelId,
          status: "running", updatedAt: "2026-10-26T00:00:00.000Z" }]] : [];
    }
    window.qa = {
      mount() {
        flushSync(() => root?.unmount());
        view = { cwd: "/workspace-A", channelId: "A" }; requests = 0; calls = []; pending = []; feedback = [];
        hold = false; queued = []; workflow = false;
        root = createRoot(document.getElementById("root"));
        flushSync(() => root.render(<Harness />));
        flushSync(() => api.actions.setSelectedChannelId("A"));
      },
      change(next) {
        hold = false;
        view = { ...view, ...next };
        flushSync(() => { api.actions.setSelectedChannelId(view.channelId); root.render(<Harness />); });
      },
      navigateTask(channelId, { taskFirst = false, inject = false, select = false } = {}) {
        const task = { id: "task-" + channelId, channelId };
        view = { ...view, channelId };
        flushSync(() => {
          if (taskFirst && inject) api.actions.setTasks(current => [task, ...current]);
          api.actions.setSelectedChannelId(channelId);
          if (!taskFirst && inject) api.actions.setTasks(current => [task, ...current]);
          if (select) api.actions.setSelectedTaskId(task.id);
          root.render(<Harness />);
        });
      },
      save(method) { const action = api.actions[method], input = args(method); saved = () => action(...input); },
      schedule(publish) { if (hold) queued.push(publish); else publish(); },
      holdSetters() { hold = true; },
      releaseSetters() { hold = false; flushSync(() => { for (const publish of queued.splice(0)) publish(); }); },
      withWorkflow() { workflow = true; },
      startSaved() { calls.push(saved()); },
      start(method) { calls.push(api.actions[method](...args(method))); },
      http(name, ...args) {
        requests++;
        return new Promise((resolve, reject) => pending.push({ name, args, resolve, reject }));
      },
      async finish(reject = false, tag = "late") {
        while (pending.length > 0) {
          for (const request of pending.splice(0)) reject ? request.reject(new Error("old panel error"))
            : request.resolve(response(request.name, tag));
          await tick();
        }
        await Promise.all(calls.splice(0)); await tick();
      },
      async settleBatch(tag) {
        for (const request of pending.splice(0)) request.resolve(response(request.name, tag));
        await tick();
      },
      async finishNewest(tag) {
        // The latest call's HTTP group comes after the preceding call's group.
        const count = pending.length / 2;
        for (const request of pending.splice(count)) request.resolve(response(request.name, tag));
        await calls.at(-1); await tick();
      },
      snapshot() {
        const s = api.state;
        return { requests, feedback, queued: queued.length, pendingNames: pending.map(request => request.name),
          panels: { proposals: s.channelExecutionProposals,
          attachments: s.channelAttachments, links: s.channelLinkPreviews, routes: s.channelMessageRouteDecisions,
          intents: s.channelIntentDecisions, brief: s.channelBrief, protocol: s.channelCollaborationProtocol,
          decisions: s.channelDecisions, handoffs: s.channelHandoffs, summaries: s.channelContextSummaries,
          steps: s.channelWorkflowSteps,
          tasks: s.tasks, selectedTaskId: s.selectedTaskId, tasksLoading: s.tasksLoading, policy: s.channelCouncilPolicy, council: s.channelEffectiveCouncil,
          councilLoading: s.channelCouncilLoading, notifications: s.channelGovernanceNotifications,
          notificationsLoading: s.channelGovernanceNotificationsLoading, artifacts: s.channelArtifactsByRun,
          artifactErrors: s.channelArtifactErrorsByRun, artifactsLoading: s.channelRunArtifactsLoading,
          actions: s.channelExecutionActions, actionError: s.channelExecutionActionError,
          transitions: s.channelStateTransitions, transitionsLoading: s.channelActivityTransitionsLoading,
          transitionError: s.channelActivityTransitionError,
          filesLoading: s.channelFilesLoading, protocolLoading: s.channelProtocolLoading, error: api.error } };
      },
    };
  `;
}
