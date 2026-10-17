import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryMarkdownExport } from "../../../packages/core/dist/index.js";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

const guidance = "Keep this off unless the exported file will remain in a trusted local boundary.";
const noop = () => {};

async function fixture(t) {
  const port = catalogHookPort();
  const apiCalls = [];
  const downloads = [];
  const memory = (id, sensitivity, body) => ({ id, workspaceId: "workspace", scopeType: "workspace", ownerId: "workspace",
    title: `Synthetic ${id}`, body, sensitivity, tags: [], sourceRefs: [], enabled: true, verifyBeforeUse: true,
    reviewState: "active", createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" });
  const memories = [memory("normal", "normal", "Ordinary synthetic QA note"),
    memory("restricted", "secret-adjacent", "Synthetic restricted QA note; sk-c010-synthetic-not-a-real-key")];
  const ports = {
    hooks: port.hooks, toast: { dismissToast: noop, showToast: () => "qa-toast" },
    downloadMemoryMarkdown: (...args) => downloads.push(args), loadTeammateMemorySnapshot: async () => undefined,
    api: { exportMemoryMarkdown: async (cwd, options) => {
      apiCalls.push({ cwd, options });
      return { export: buildMemoryMarkdownExport({ memories, options: { workspaceId: "workspace", generatedAt: "2026-10-17T00:00:00.000Z", ...options } }) };
    }, importMemoryMarkdown: async () => { throw new Error("not in scope"); }, reviewMemory: noop, updateMemoryReviewPolicy: noop },
  };
  const fromPort = (names, target) => key => `const { ${names} } = globalThis[${JSON.stringify(key)}].ports${target ? `.${target}` : ""};`;
  const h = await catalogConsumerHarness(t, {
    exports: {
      "features/teammates/useTeammateMemoryController.ts": ["useTeammateMemoryController"],
      "features/teammates/TeammateMemoryGovernanceSection.tsx": ["TeammateMemoryGovernanceSection"],
    }, ports,
    transforms: { "features/teammates/useTeammateMemoryController.ts": [
      { anchor: 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
        replace: fromPort("useCallback, useEffect, useMemo, useRef, useState", "hooks") },
      { anchor: 'import {\n  exportMemoryMarkdown,\n  importMemoryMarkdown,\n  reviewMemory,\n  updateMemoryReviewPolicy,\n} from "../../api.js";',
        replace: key => ["exportMemoryMarkdown", "importMemoryMarkdown", "reviewMemory", "updateMemoryReviewPolicy"]
          .map(name => `const ${name} = (...args) => globalThis[${JSON.stringify(key)}].ports.api.${name}(...args);`).join("\n") },
      { anchor: 'import { useLingToast } from "../../shared/ui/index.js";',
        replace: key => `const useLingToast = () => globalThis[${JSON.stringify(key)}].ports.toast;` },
      { anchor: 'import { downloadMemoryMarkdown } from "./teammate-memory-files.js";', replace: fromPort("downloadMemoryMarkdown") },
      { anchor: 'import { loadTeammateMemorySnapshot } from "./teammate-memory-data.js";', replace: fromPort("loadTeammateMemorySnapshot") },
    ] },
  });
  await h.select("ru-RU");
  let input = { channels: [], cwd: "/isolated/c010", teammate: { id: "qa-a", displayName: "QA", roleKey: "custom" } };
  const render = () => port.render(h.module.useTeammateMemoryController, input);
  let controller = render();
  await port.flush();
  controller = render();
  return { h, ports, apiCalls, downloads, render, port, controller,
    async changeScope() { input = { ...input, teammate: { ...input.teammate, id: "qa-b" } }; render(); await port.flush(); return render(); } };
}

test("C010 real Russian governance disclosure expresses keep-off-unless without changing its switch state", async t => {
  const f = await fixture(t);
  const controller = { ...f.controller, snapshot: { policy: { mode: "balanced" } }, viewModel: { reviewRows: [] } };
  const markup = f.h.render(f.h.module.TeammateMemoryGovernanceSection, { controller });
  const text = f.h.state.calls.find(call => call.key === guidance)?.text;
  assert.ok(text && markup.includes(text));
  assert.equal(f.controller.exportIncludeSecretAdjacent, false);
  assert.deepEqual(f.apiCalls, []);
  assert.match(text, /(?:остав|держ)[^.!?]{0,45}(?:выключ|отключ)/iu);
  assert.match(text, /(?:если|кроме)/iu);
  assert.doesNotMatch(text, /не отключайте/iu);
});

test("C010 actual controller defaults/reset false and exports only the explicit switch value through real redaction", async t => {
  const f = await fixture(t);
  let controller = f.controller;
  for (const include of [false, true]) {
    controller.setExportIncludeSecretAdjacent(include);
    controller = f.render();
    assert.equal(controller.exportIncludeSecretAdjacent, include);
    await controller.exportProjection();
    controller = f.render();
    const call = f.apiCalls.at(-1);
    assert.deepEqual(call, { cwd: "/isolated/c010", options: { includeMarkdown: true, includeSecretAdjacent: include } });
    const markdown = f.downloads.at(-1)[1];
    assert.equal(markdown.includes("Synthetic restricted QA note"), include);
    assert.equal(markdown.includes("sk-c010-synthetic-not-a-real-key"), false);
  }
  controller = await f.changeScope();
  assert.equal(controller.exportIncludeSecretAdjacent, false);
  assert.equal(controller.transferBusy, "");
  assert.equal(f.apiCalls.length, 2, "scope changes cannot silently export any data");
});

test("C010 pending export keeps the switch disabled and does not schedule a second export", async t => {
  const f = await fixture(t);
  let resolve;
  f.ports.api.exportMemoryMarkdown = (cwd, options) => {
    f.apiCalls.push({ cwd, options });
    return new Promise(done => { resolve = done; });
  };
  const pending = f.controller.exportProjection();
  const busy = f.render();
  assert.equal(busy.transferBusy, "export");
  await busy.exportProjection();
  assert.equal(f.apiCalls.length, 1);
  const markup = f.h.render(f.h.module.TeammateMemoryGovernanceSection, { controller: {
    ...busy, snapshot: { policy: { mode: "balanced" } }, viewModel: { reviewRows: [] },
  } });
  assert.match(markup, /role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/u);
  resolve({ export: { suggestedFileName: "synthetic-qa.md", markdown: "Synthetic QA only", memoryCount: 0 } });
  await pending;
  assert.equal(f.render().transferBusy, "");
});

test("C010 missing Russian guidance uses actual English fallback while export errors remain explicit", async t => {
  const f = await fixture(t);
  await f.h.select("ru-RU", [guidance]);
  assert.equal(f.h.state.t(guidance), guidance);
  f.ports.api.exportMemoryMarkdown = async () => { throw new Error("Synthetic unavailable export"); };
  await f.controller.exportProjection();
  const failed = f.render();
  assert.equal(failed.transferBusy, "");
  assert.equal(failed.exportIncludeSecretAdjacent, false);
  assert.equal(failed.exportError, f.h.state.t("Memory export failed. Try again."));
  assert.deepEqual(f.downloads, []);
});
