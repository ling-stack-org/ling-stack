import assert from "node:assert/strict";
import test from "node:test";
import { terminalReportDisplaySourceRefs, terminalReportSourceRefGroups } from "../src/shared/conversation/timeline/terminal-report-display-refs.ts";

test("report paths reuse original file identity and gain a full-path tooltip without authority", () => {
  const ref = Object.freeze({ kind: "file", id: "docs/public.txt", label: "public.txt", visibility: "folded_evidence" });
  const refs = Object.freeze([ref]);
  const fallback = Object.freeze({ kind: "file", id: "report-path:change:docs/public.txt", path: "docs/public.txt", label: "docs/public.txt" });
  const projected = terminalReportDisplaySourceRefs(refs, [fallback]);
  assert.deepEqual(projected, [{ ...ref, path: "docs/public.txt" }]);
  assert.equal(projected[0].capabilityId, undefined);
  assert.equal(projected[0].hostTarget, undefined);
  assert.equal(ref.path, undefined);
  assert.deepEqual(terminalReportDisplaySourceRefs(projected, [fallback]), projected);
});

test("artifact paths do not duplicate their file evidence and retain real diff targets", () => {
  const file = { kind: "file", id: "docs/public.txt", label: "public.txt" };
  const diff = { kind: "diff", id: "diff-original", path: "docs/public.txt", hostTarget: "open_diff", capabilityId: "existing-capability" };
  const fallback = { kind: "diff", id: "artifact-report", path: "docs/public.txt", label: "public.txt" };
  assert.deepEqual(terminalReportDisplaySourceRefs([file], [fallback]), [{ ...file, path: "docs/public.txt" }]);
  assert.deepEqual(terminalReportDisplaySourceRefs([file, diff], [fallback]), [{ ...file, path: "docs/public.txt" }, diff]);
  const artifact = { kind: "artifact", id: fallback.id, label: "original artifact" };
  assert.deepEqual(terminalReportDisplaySourceRefs([artifact], [fallback]), [{ ...artifact, path: fallback.path }]);
});

test("full-path matching tolerates display separators but never merges basenames or labels", () => {
  const original = { kind: "file", id: "action-file", path: "src\\a.ts", label: "a.ts" };
  const fallback = { kind: "file", id: "report-path:a", path: "./src/a.ts" };
  assert.deepEqual(terminalReportDisplaySourceRefs([original], [fallback]), [original]);
  const other = { kind: "file", id: "other/a.ts", label: "a.ts" };
  assert.deepEqual(terminalReportDisplaySourceRefs([other], [fallback]), [other, fallback]);
  const labelOnly = { kind: "memory", id: "memory", label: "./src/a.ts" };
  assert.deepEqual(terminalReportDisplaySourceRefs([labelOnly], [fallback]), [labelOnly, fallback]);
});

test("exact artifact identity enriches a label-only report ref before path fallback dedupe", () => {
  const source = { kind: "artifact", id: "artifact-diff", label: "ConversationWorkCell.tsx" };
  const path = "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx";
  const resource = { kind: "diff", id: source.id, path, label: source.label };
  const fallback = { kind: "file", id: `report-path:${path}`, path, label: path };
  assert.deepEqual(terminalReportDisplaySourceRefs([source], [fallback], [resource]), [{ ...source, path }]);
});

test("missing evidence retains one display-only fallback and canonical references stay intact", () => {
  const fallback = { kind: "file", id: "report-path:a", path: "src/a.ts" };
  assert.deepEqual(terminalReportDisplaySourceRefs([], [fallback, fallback]), [fallback]);
  const a = { kind: "file", id: "first-action", path: "src/a.ts" };
  const b = { kind: "file", id: "second-action", path: "src/a.ts" };
  assert.deepEqual(terminalReportDisplaySourceRefs([a, b, a], [fallback]), [a, b]);
});

test("mixed refs disclose metadata separately without file icons or new authority", () => {
  const file = Object.freeze({ kind: "file", id: "file", path: "src/a.ts", capabilityId: "existing" });
  const task = Object.freeze({ kind: "task", id: "task", label: "task", path: "not-a-file" });
  const call = Object.freeze({ kind: "external", id: "call", label: "call_original" });
  const refs = Object.freeze([task, file, call, file, { kind: "run", id: "unlabeled" }]);
  const grouped = terminalReportSourceRefGroups(refs);
  assert.deepEqual(grouped, { resources: [file], lineage: [task, call] });
  assert.equal(grouped.resources[0], file);
  assert.equal(grouped.lineage[0], task);
  assert.equal(refs.length, 5);
});

test("grouping preserves distinct evidence, stable order and last revision per identity", () => {
  const first = { kind: "file", id: "first", path: "src/a.ts" };
  const newer = { ...first, label: "updated" };
  const second = { kind: "diff", id: "second", path: "src/a.ts" };
  const artifact = { kind: "artifact", id: "artifact", label: "download" };
  const path = { kind: "path", id: "path", path: "src/b.ts" };
  assert.deepEqual(terminalReportSourceRefGroups([first, second, newer, artifact, path]), {
    resources: [newer, second, artifact, path], lineage: [],
  });
  assert.deepEqual(terminalReportSourceRefGroups([]), { resources: [], lineage: [] });
});
