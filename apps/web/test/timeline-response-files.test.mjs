import assert from "node:assert/strict";
import test from "node:test";
import { projectTimelineResponseFiles, projectTimelineResponseReview, timelineResponseRecoveryTarget } from "../src/shared/conversation/timeline/timeline-response-files.ts";

function fileChange(id, path, overrides = {}) {
  return { id, actionId: id, kind: "fileChange", status: "succeeded", sourceRefs: [],
    files: [{ fileRef: { kind: "file", id: path, path }, displayName: path, additions: 3, deletions: 1 }], ...overrides };
}
const response = (items, report) => ({ items, report });
const report = (changes) => ({ kind: "terminalReport", title: "Completed", summary: "Completed", changes,
  verification: [], participants: [], artifacts: [], risks: [], corrections: [], references: [], sourceRefs: [], outcomeSourceRefs: [] });

test("only successful applied file facts appear, never running, failed, or approval previews", () => {
  const result = projectTimelineResponseFiles(response([fileChange("ok", "app.ts"),
    fileChange("failed", "failed.ts", { status: "failed" }), fileChange("live", "live.ts", { status: "running" }),
    { id: "preview", kind: "approval", changePreview: { path: "preview.ts" } }]));
  assert.deepEqual(result.map((file) => file.path), ["app.ts"]);
  assert.equal(result[0].additions, 3);
});

test("same action is deduplicated; repeat edits retain diff evidence without claiming net counts", () => {
  const first = fileChange("edit1", "app.ts", { changePreview: { artifactId: "diff1" }, sourceRefs: [{ kind: "diff", id: "diff1" }] });
  const second = fileChange("edit2", "app.ts", { changePreview: { artifactId: "diff2" }, sourceRefs: [{ kind: "diff", id: "diff2" }] });
  const files = projectTimelineResponseFiles(response([first, first, second]));
  assert.equal(files.length, 1);
  assert.equal(files[0].additions, undefined);
  assert.equal(files[0].deletions, undefined);
  assert.deepEqual(files[0].diffs.map((diff) => diff.ref.id), ["diff1", "diff2"]);
});

test("missing or invalid stats never become zero", () => {
  for (const additions of [undefined, -1, NaN, Infinity]) {
    const item = fileChange("one", "app.ts");
    item.files[0].additions = additions;
    const [file] = projectTimelineResponseFiles(response([item]));
    assert.equal(file.additions, undefined);
    assert.equal(file.deletions, undefined);
  }
});

test("private and reserved internal paths cannot be redisclosed by the summary", () => {
  const privateItem = fileChange("private", "private.txt");
  privateItem.files[0].fileRef.visibility = "private";
  const files = projectTimelineResponseFiles(response([privateItem, fileChange("internal", ".ling-stack/reports/internal.json"),
    fileChange("run-internal", "run_1/result.json", { sourceRefs: [{ kind: "run", id: "run_1" }] })]));
  assert.deepEqual(files, []);
});

test("report-only paths preserve display without inventing executable lineage or statistics", () => {
  const files = projectTimelineResponseFiles(response([], report([{ id: "change", paths: ["app.ts"], sourceRefs: [], title: "Updated", summary: "Updated" }])));
  assert.equal(files[0].path, "app.ts");
  assert.equal(files[0].item, undefined);
  assert.equal(files[0].additions, undefined);
});

test("a Host report's relative alias and the applied file identity produce one file row", () => {
  const absolute = "/private/tmp/qa-workspace/project/H2-result.json";
  const item = fileChange("actual-write", absolute);
  const value = response([item], report([{ id: "change", paths: ["project/H2-result.json"],
    sourceRefs: [{ kind: "operation", id: item.actionId }, { kind: "file", id: absolute }] }]));
  const files = projectTimelineResponseFiles(value);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, absolute);
  assert.equal(files[0].item, item);
  assert.equal(files[0].fileRef, item.files[0].fileRef);
  assert.equal(item.files[0].fileRef.path, absolute, "projection must not rewrite the capability target");
});

test("review coverage follows the same evidence-backed relative alias without adding an unknown duplicate", () => {
  const absolute = "/private/tmp/qa-workspace/project/H2-result.json";
  const item = fileChange("actual-write", absolute);
  const value = response([item], report([{ paths: ["project/H2-result.json"],
    sourceRefs: [{ kind: "operation", id: item.actionId }, { kind: "file", id: absolute }] }]));
  const projected = projectTimelineResponseReview(value, exactReview([{ path: "project/H2-result.json", additions: 16, deletions: 0 }]));
  assert.deepEqual(projected.files.map((file) => file.path), ["project/H2-result.json"]);
  assert.equal(projected.state, "exact");
  assert.equal(projected.additions, 16);
  assert.equal(projected.deletions, 0);
});

test("matching basenames or suffixes without matching Host file identity never collapse distinct files", () => {
  const first = "/private/tmp/first/project/result.json";
  const second = "/private/tmp/second/project/result.json";
  const value = response([fileChange("first", first), fileChange("second", second)],
    report([{ paths: ["project/result.json"], sourceRefs: [] }]));
  assert.deepEqual(projectTimelineResponseFiles(value).map((file) => file.path), [first, second, "project/result.json"]);
});

test("matching file identity cannot alias a report tied to a different operation", () => {
  const absolute = "/private/tmp/qa-workspace/project/result.json";
  const relative = "project/result.json";
  const item = fileChange("actual-write", absolute);
  const value = response([item], report([{ paths: [relative], sourceRefs: [
    { kind: "file", id: absolute }, { kind: "operation", id: "other-write" },
  ] }]));
  const before = structuredClone(value);
  assert.deepEqual(projectTimelineResponseFiles(value).map((file) => file.path), [absolute, relative]);
  const projected = projectTimelineResponseReview(value, exactReview([{ path: relative }]));
  assert.equal(projected.state, "partial");
  assert.equal(projected.additions, undefined);
  assert.deepEqual(projected.files.map((file) => file.path), [relative, absolute]);
  assert.deepEqual(value, before, "a rejected alias must not rewrite Host references");
});

test("ambiguous Host file identity never chooses an absolute alias arbitrarily", () => {
  const first = "/private/tmp/first/project/result.json";
  const second = "/private/tmp/second/project/result.json";
  const relative = "project/result.json";
  const items = [fileChange("first-write", first), fileChange("second-write", second)];
  for (const item of items) item.files[0].fileRef.id = "ambiguous-host-file";
  const value = response(items, report([{ paths: [relative], sourceRefs: [
    { kind: "file", id: "ambiguous-host-file" },
  ] }]));
  const before = structuredClone(value);
  assert.deepEqual(projectTimelineResponseFiles(value).map((file) => file.path), [first, second, relative]);
  const projected = projectTimelineResponseReview(value, exactReview([{ path: relative }]));
  assert.equal(projected.state, "partial");
  assert.equal(projected.additions, undefined);
  assert.deepEqual(projected.files.map((file) => file.path), [relative, first, second]);
  assert.deepEqual(value, before, "ambiguous evidence must stay unchanged for audit");
});

test("a private report alias cannot redisclose its absolute applied target or review statistics", () => {
  const absolute = "/private/tmp/qa-workspace/project/private.json";
  const value = response([fileChange("actual-write", absolute)], report([{ paths: ["project/private.json"],
    sourceRefs: [{ kind: "file", id: absolute, visibility: "private" }] }]));
  assert.deepEqual(projectTimelineResponseFiles(value), []);
  const projected = projectTimelineResponseReview(value, exactReview([
    { path: absolute, additions: 9 }, { path: "project/private.json", additions: 9 },
  ]));
  assert.deepEqual(projected.files, []);
  assert.equal(projected.additions, 0);
});

test("a preview not returned as durable result evidence cannot gain a diff affordance", () => {
  const [file] = projectTimelineResponseFiles(response([fileChange("edit", "app.ts", { changePreview: { artifactId: "preview" } })]));
  assert.equal(file.diffRef, undefined);
});

const exactReview = (files, coveredPaths = files.map((file) => file.path)) => ({ scope: { kind: "run", id: "run_a" }, workspaceId: "workspace", runIds: ["run_a"], revision: "1", state: "exact", coveredPaths,
  files: files.map((file) => ({ id: file.path, path: file.path, kind: "modified", state: "exact", additions: 1, deletions: 1, diff: "diff", ...file })), additions: 999, deletions: 999 });

test("review uses Host net stats; missing report paths make totals unknown, not patch sums", () => {
  const value = response([fileChange("edit", "app.ts")], report([{ paths: ["app.ts", "missing.ts"], sourceRefs: [] }]));
  const projected = projectTimelineResponseReview(value, exactReview([{ path: "app.ts", additions: 2, deletions: 0 }]));
  assert.equal(projected.state, "partial"); assert.equal(projected.additions, undefined); assert.equal(projected.deletions, undefined);
  assert.deepEqual(projected.files.map((file) => [file.path, file.additions]), [["app.ts", 2], ["missing.ts", undefined]]);
});

test("covered restored files stay absent; an exact empty review is not repopulated by reports", () => {
  const value = response([fileChange("edit", "app.ts")]);
  const projected = projectTimelineResponseReview(value, exactReview([], ["app.ts"]));
  assert.deepEqual(projected.files, []); assert.equal(projected.additions, 0); assert.equal(projected.deletions, 0);
});

test("private/internal paths stay hidden when Host review is projected or aggregate statistics recalculated", () => {
  const value = response([], report([{ paths: ["app.ts"], sourceRefs: [] }, { paths: ["private.ts"], sourceRefs: [{ kind: "file", id: "p", path: "private.ts", visibility: "private" }] }]));
  const projected = projectTimelineResponseReview(value, exactReview([{ path: "app.ts", additions: 2 }, { path: ".ling-stack/private.txt" }, { path: "private.ts" }]));
  assert.deepEqual(projected.files.map((file) => file.path), ["app.ts"]);
  assert.equal(projected.additions, 2); assert.equal(projected.deletions, 1);
});

test("child always scopes to its run, even if it inherits the parent Turn/workflow", () => {
  const value = { items: [], message: { runId: "child", turnId: "parent" }, report: { runId: "child", turnId: "parent", sourceRefs: [{ kind: "workflow", id: "workflow" }] } };
  assert.deepEqual(timelineResponseRecoveryTarget(value, 1), { kind: "run", id: "child" });
  assert.deepEqual(timelineResponseRecoveryTarget(value, 0), { kind: "workflow", id: "workflow" });
  assert.deepEqual(timelineResponseRecoveryTarget({ ...value, report: undefined }, 0), { kind: "turn", id: "parent" });
});
