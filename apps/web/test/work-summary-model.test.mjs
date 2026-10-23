import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const code = stripTypeScriptTypes(readFileSync(new URL("../src/features/workspace/work-summary/work-summary-model.ts", import.meta.url), "utf8"), { mode: "transform" });
const { buildWorkSummaryGroups, retainSummaryEvidence } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const workspace = { key: "/repo", cwd: "/repo", state: "ready", additions: 7, deletions: 2, partial: false, commits: [], checkedAt: "old" };
const previous = { cwd: "/project", checkedAt: "old", truncated: false, sessions: [{ id: "one", workspaceKey: "/repo" }, { id: "two", workspaceKey: "/repo" }], workspaces: [workspace], pullRequests: [{ url: "https://github.com/a/b/pull/1", state: "open", connection: "connected", title: "PR title", headSha: "old" }] };

test("shared workspace is grouped once and unbound sessions remain independent", () => {
  const groups = buildWorkSummaryGroups({ ...previous, sessions: [...previous.sessions, { id: "unbound" }] });
  assert.equal(groups.length, 2); assert.equal(groups[0].sessions.length, 2); assert.equal(groups[0].workspace.additions, 7);
  assert.equal(groups[1].workspace, undefined);
});
test("partial failures preserve last successful evidence and its timestamps with an error", () => {
  const next = { ...previous, checkedAt: "new", workspaces: [{ ...workspace, state: "unavailable", additions: undefined, checkedAt: "new", error: "offline" }],
    pullRequests: [{ url: previous.pullRequests[0].url, state: "unknown", connection: "error", error: "offline" }] };
  const retained = retainSummaryEvidence(next, previous);
  assert.equal(retained.workspaces[0].additions, 7); assert.equal(retained.workspaces[0].checkedAt, "old"); assert.equal(retained.workspaces[0].error, "offline");
  assert.equal(retained.pullRequests[0].title, "PR title"); assert.equal(retained.pullRequests[0].connection, "error");
  assert.equal(retainSummaryEvidence({ ...next, cwd: "/other" }, previous).workspaces[0].additions, undefined);
});
