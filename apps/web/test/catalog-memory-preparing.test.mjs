import assert from "node:assert/strict";
import test from "node:test";
import { ToastProvider } from "@ling-stack/ui-react";
import { catalogConsumerHarness, React } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

test("C012 ta-IN real private-workspace memory controller→summary distinguishes preparing from ready", async t => {
  const port = catalogHookPort();
  const calls = [];
  const ports = { hooks: port.hooks, snapshot: { scopes: [], memories: [], inbox: [], usedEvents: [],
    health: { summary: { findings: { critical: 0, warning: 0, info: 0 } } }, policy: { mode: "balanced" },
    vectorRetrieval: { status: "not_installed", optional: true } } };
  const h = await catalogConsumerHarness(t, {
    exports: {
      "features/teammates/TeammateWorkspace.tsx": ["TeammateWorkspace"],
      "shared/current-session/CurrentSessionHeaderCapability.tsx": ["CurrentSessionHeaderCapabilityProvider"],
    }, ports,
    transforms: {
      "features/teammates/useTeammateMemoryController.ts": [
        { anchor: 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
          replace: key => `const { useCallback, useEffect, useMemo, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
        { anchor: 'import { loadTeammateMemorySnapshot } from "./teammate-memory-data.js";',
          replace: key => `const loadTeammateMemorySnapshot = (...args) => globalThis[${JSON.stringify(key)}].ports.loadSnapshot(...args);` },
      ],
      "features/teammates/TeammateWorkspace.tsx": [
        { anchor: "  const memoryController = useTeammateMemoryController({ cwd, teammate, channels });",
          replace: key => `  const memoryController = useTeammateMemoryController({ cwd, teammate, channels });\n  globalThis[${JSON.stringify(key)}].captures.memoryController = memoryController;` },
        { anchor: "  const chatDockController = useWorkspaceRightDockController({",
          replace: key => `  globalThis[${JSON.stringify(key)}].captures.summaryRows = privateSummaryRows;\n  const chatDockController = useWorkspaceRightDockController({` },
      ],
    },
  });
  ports.loadSnapshot = async (...args) => { calls.push(args); return ports.snapshot; };
  await h.select("ta-IN");
  const teammate = { id: "c012-memory-qa", displayName: "Synthetic QA", description: "Offline fixture", roleKey: "custom",
    status: "active", hidden: false, pinned: false, allowedTools: ["read"], approvalProfile: { mode: "read_only" },
    modelBindingMode: "fixed", providerPresetId: "", appendSystemPrompt: [], updatedAt: "2026-10-17T00:00:00.000Z" };
  const props = { cwd: "/isolated/c012", teammate, providers: [], channels: [], runs: [], workUnits: [], skillPack: undefined,
    onUpdateTeammate: async () => { throw new Error("must not update a real teammate"); }, onDisableTeammate: async () => {},
    onOpenProviders: () => {}, approvalErrors: {}, resolvingApprovals: {}, onResolveApproval: () => {} };
  const render = () => port.render(() => h.render(ToastProvider, {
    children: React.createElement(h.module.CurrentSessionHeaderCapabilityProvider, null,
      React.createElement(h.module.TeammateWorkspace, props)),
  }));
  render();
  const beforeLoad = h.state.captures.summaryRows.find(row => row.id === "memory").secondary;
  assert.ok(h.state.calls.some(call => call.key === "Memory preparing" && call.text === beforeLoad));
  await port.flush();
  render();
  const empty = h.state.captures.summaryRows.find(row => row.id === "memory").secondary;
  assert.equal(empty, beforeLoad);
  assert.deepEqual(calls, [["/isolated/c012", teammate.id]]);
  ports.snapshot = { ...ports.snapshot, scopes: [{ id: "scope-qa", teammateId: teammate.id, kind: "private-notes", enabled: true,
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" }] };
  await h.state.captures.memoryController.refresh();
  render();
  const active = h.state.captures.summaryRows.find(row => row.id === "memory").secondary;
  assert.equal(active, h.state.t("Memory on"));
  assert.notEqual(active, empty);
  assert.match(empty, /தயாராகி|தயாரிப்பு|தயாராக்க/u);
  assert.notEqual(empty, h.state.t("Memory ready"), "an empty scope is not a ready-memory claim");
});
