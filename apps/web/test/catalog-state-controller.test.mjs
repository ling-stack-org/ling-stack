import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

const noop = () => {};
const hooks = (names) => ({ anchor: `import { ${names} } from "react";`,
  replace: key => `const { ${names} } = globalThis[${JSON.stringify(key)}].ports.hooks;` });

async function snapshotFixture(t, request) {
  const port = catalogHookPort();
  const calls = [];
  const ports = { hooks: port.hooks, listRunShellSnapshots: (...args) => { calls.push(args); return request(...args); } };
  const h = await catalogConsumerHarness(t, {
    exports: { "features/runs/ShellSnapshotPanel.tsx": ["ShellSnapshotPanel"] }, ports,
    transforms: { "features/runs/ShellSnapshotPanel.tsx": [
      hooks("useEffect, useRef, useState"),
      { anchor: 'import { artifactContentUrl, listRunShellSnapshots } from "../../api.js";',
        replace: key => `import { artifactContentUrl } from "../../api.js";\nconst listRunShellSnapshots = (...args) => globalThis[${JSON.stringify(key)}].ports.listRunShellSnapshots(...args);` },
    ] },
  });
  await h.select("tr-TR");
  const props = { cwd: "/isolated/c012", run: { id: "snapshot-qa" }, artifacts: [] };
  const render = () => port.render(() => h.render(h.module.ShellSnapshotPanel, props));
  return { h, port, ports, calls, render };
}

test("C012 tr-TR actual snapshot API→state→empty consumer says no recorded snapshots, not no unrecorded ones", async t => {
  let resolve;
  const f = await snapshotFixture(t, () => new Promise(done => { resolve = done; }));
  f.render();
  await f.port.flush();
  f.h.state.calls.length = 0;
  const loading = f.render();
  assert.equal(loading.includes('class="ling-ui-empty-state'), false);
  assert.equal(f.h.state.calls.some(call => call.key === "No shell snapshots recorded for this run"), false);
  resolve({ snapshots: [] });
  await f.port.flush();
  const markup = f.render();
  const text = f.h.state.calls.find(call => call.key === "No shell snapshots recorded for this run")?.text;
  assert.ok(text && markup.includes(text));
  assert.deepEqual(f.calls, [["snapshot-qa", "/isolated/c012"]]);
  assert.match(text, /kaydedil(?:en|miş).{0,50}(?:yok|bulunmuyor)|kaydedilmedi/iu);
  assert.doesNotMatch(text, /kaydedilmemiş/iu);
});

test("C012 actual snapshot failures render warning rather than the empty-recorded message", async t => {
  const f = await snapshotFixture(t, async () => { throw new Error("Synthetic snapshot unavailable"); });
  f.render();
  await f.port.flush();
  f.h.state.calls.length = 0;
  const markup = f.render();
  assert.ok(markup.includes("Synthetic snapshot unavailable"));
  assert.ok(f.h.state.calls.some(call => call.key === "Shell snapshot diagnostics unavailable"));
  assert.equal(f.h.state.calls.some(call => call.key === "No shell snapshots recorded for this run"), false);
});

test("C012 actual populated snapshots preserve command identity and suppress the empty-state guidance", async t => {
  const f = await snapshotFixture(t, async () => ({ snapshots: [{ id: "qa-snapshot", artifactId: "qa-artifact", commandPreview: "Synthetic command preview",
    toolCallId: "qa-tool", sequence: 1, status: "succeeded", createdAt: "2026-10-17T00:00:00.000Z", exitCode: 0, durationMs: 1 }] }));
  f.render();
  await f.port.flush();
  f.h.state.calls.length = 0;
  const markup = f.render();
  assert.ok(markup.includes("Synthetic command preview"));
  assert.ok(markup.includes("qa-tool"));
  assert.equal(f.h.state.calls.some(call => call.key === "No shell snapshots recorded for this run"), false);
});

test("C012 te-IN actual archived panel and controller dispatch Unarchive, never Archive, with its idempotency payload", async t => {
  const port = catalogHookPort();
  const calls = [];
  let thread = { id: "c012-thread", title: "Synthetic QA", kind: "conversation", status: "archived",
    updatedAt: "2026-10-17T00:00:00.000Z", archivedAt: "2026-10-17T00:00:00.000Z" };
  const apiNames = ["archiveLingThread", "forkLingThread", "forkRunLingThread", "getLingThreadEvidence", "listRunInterventions", "pinLingThread",
    "previewLingThreadResume", "resumeLingThread", "unarchiveLingThread", "unpinLingThread"];
  const api = Object.fromEntries(apiNames.map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (name === "getLingThreadEvidence") return { thread, runs: [], actions: [], transitions: [] };
    if (name === "unarchiveLingThread") {
      thread = { ...thread, status: "idle", archivedAt: undefined };
      return { thread };
    }
    throw new Error(`unexpected QA IO: ${name}`);
  }]));
  const h = await catalogConsumerHarness(t, {
    exports: { "features/runs/ThreadDetailPanel.tsx": ["ThreadDetailPanel"] }, ports: { hooks: port.hooks, api },
    transforms: {
      "features/runs/useThreadDetailController.ts": [hooks("useEffect, useMemo, useRef, useState"), {
        anchor: `import {\n${apiNames.map(name => `  ${name},`).join("\n")}\n} from "../../api.js";`,
        replace: key => apiNames.map(name => `const ${name} = (...args) => globalThis[${JSON.stringify(key)}].ports.api.${name}(...args);`).join("\n"),
      }],
      "features/runs/ThreadDetailPanel.tsx": [{ anchor: "  const { state, actions } = controller;",
        replace: key => `  const { state, actions } = controller;\n  globalThis[${JSON.stringify(key)}].captures.threadController = controller;` }],
    },
  });
  await h.select("te-IN");
  const props = { cwd: "/isolated/c012", thread, threadId: thread.id, visibleThreads: [], isRunning: false,
    onRefresh: noop, onSelectRun: noop, onSelectThreadId: noop };
  const render = () => port.render(() => h.render(h.module.ThreadDetailPanel, props));
  render();
  await port.flush();
  const archivedMarkup = render();
  const text = h.state.calls.filter(call => call.key === "Unarchive").at(-1)?.text;
  assert.ok(text && archivedMarkup.includes(text));
  assert.equal(h.state.captures.threadController.state.isArchived, true);
  await h.state.captures.threadController.actions.mutate("unarchive");
  await port.flush();
  render();
  assert.deepEqual(calls.filter(call => call.name !== "getLingThreadEvidence"), [{ name: "unarchiveLingThread",
    args: ["/isolated/c012", "c012-thread", { idempotencyKey: "work-history-unarchive:c012-thread" }] }]);
  assert.equal(h.state.captures.threadController.state.isArchived, false);
  assert.equal(h.state.captures.threadController.state.canResume, false, "unarchiving alone is not evidence that a source run exists");
  assert.match(text, /(?:ఆర్కైవ్).{0,35}(?:తీసి|తొలగి|రద్దు)|అన్‌ఆర్కైవ్/u);
  assert.doesNotMatch(text, /^ఆర్కైవ్ చేయి$/u);
});

test("C012 actual Full Access controller keeps explicit confirm/cancel and conversation scope isolation", async t => {
  const port = catalogHookPort();
  const h = await catalogConsumerHarness(t, {
    exports: { "app/useFullAccessConfirmationController.ts": ["useFullAccessConfirmationController"] },
    ports: { hooks: port.hooks }, transforms: { "app/useFullAccessConfirmationController.ts": [hooks("useCallback, useEffect, useRef, useState")] },
  });
  const globals = ["window", "document", "HTMLElement"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const storage = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class SyntheticElement {} });
  t.after(() => { for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  const render = () => port.render(h.module.useFullAccessConfirmationController);
  let controller = render();
  const scope = { workspaceCwd: "/isolated/c012", conversationId: "channel:qa", policyRevision: "qa-revision" };
  assert.equal(controller.isConfirmed(scope), false);
  const cancelled = controller.request(scope);
  controller = render();
  assert.equal(controller.open, true);
  controller.cancel();
  assert.equal(await cancelled, undefined);
  assert.equal(render().isConfirmed(scope), false);
  const accepted = render().request(scope);
  controller = render();
  controller.confirm();
  const confirmation = await accepted;
  assert.equal(confirmation.mode, "full_access");
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.reason, "user_confirmed_full_access");
  controller = render();
  assert.equal(controller.open, false);
  assert.equal(controller.isConfirmed(scope), true);
  assert.equal(controller.isConfirmed({ ...scope, conversationId: "channel:other" }), false);
  assert.equal(controller.isConfirmed({ ...scope, policyRevision: "different" }), false);
  assert.ok(storage.size > 0, "only the isolated test storage receives persistence");
  // This proves consent-controller behavior, not an OS sandbox or policy-enforcement test.
});
