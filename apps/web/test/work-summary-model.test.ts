import assert from "node:assert/strict";
import test from "node:test";
import type { WorkSummaryResponse, WorkSummaryWorkspace } from "@ling-stack/contracts";
import {
  buildWorkSummaryGroups,
  findCurrentSummaryWorkspace,
  isCleanSummaryWorkspace,
  retainSummaryEvidence,
} from "../src/features/workspace/work-summary/work-summary-model.ts";

const workspace: WorkSummaryWorkspace = {
  key: "/repo", cwd: "/repo/subdir", state: "ready", changedFiles: 2, additions: 7, deletions: 2,
  partial: false, commits: [], checkedAt: "old",
};
const previous: WorkSummaryResponse = {
  cwd: "/project", checkedAt: "old", truncated: false,
  sessions: [
    { id: "one", threadId: "thread-one", title: "First", status: "running", surface: "conversation", workspaceKey: "/repo" },
    { id: "two", threadId: "thread-two", title: "Second", status: "open", surface: "channel", workspaceKey: "/repo" },
  ],
  workspaces: [workspace],
  pullRequests: [{
    url: "https://github.com/a/b/pull/1", repository: "a/b", number: 1, createdAt: "old",
    state: "open", connection: "connected", ci: "pending", title: "PR title", headSha: "old",
  }],
};

test("shared workspace is grouped once and unbound sessions remain independent", () => {
  const groups = buildWorkSummaryGroups({
    ...previous,
    sessions: [...previous.sessions, { id: "unbound", title: "Unbound", status: "open", surface: "teammate" }],
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.sessions.length, 2);
  assert.equal(groups[0]?.workspace?.additions, 7);
  assert.equal(groups[1]?.workspace, undefined);
});

test("current workspace resolves only an exact thread or workspace identity", () => {
  const other = { ...workspace, key: "/other", cwd: "/other", additions: 20 };
  const summary = {
    ...previous,
    sessions: [...previous.sessions, {
      id: "three", threadId: "thread-three", title: "Other checkout", status: "running", surface: "conversation", workspaceKey: other.key,
    } as const],
    workspaces: [workspace, other],
  };
  assert.equal(findCurrentSummaryWorkspace(summary, { kind: "thread", threadId: "thread-three" }), other);
  assert.equal(findCurrentSummaryWorkspace(summary, { kind: "workspace", path: "/repo/subdir" }), workspace);
  assert.equal(findCurrentSummaryWorkspace(summary, { kind: "workspace", path: "/repo" }), workspace);
  assert.equal(findCurrentSummaryWorkspace(summary, { kind: "thread", threadId: "missing" }), undefined);
  assert.equal(findCurrentSummaryWorkspace(summary, { kind: "workspace", path: "/repo/another" }), undefined);
});

test("only complete, fresh zero-file results are clean", () => {
  const clean = { ...workspace, changedFiles: 0, additions: 0, deletions: 0 };
  assert.equal(isCleanSummaryWorkspace(clean), true);
  assert.equal(isCleanSummaryWorkspace({ ...clean, partial: true }), false);
  assert.equal(isCleanSummaryWorkspace({ ...clean, changedFiles: undefined }), false);
  assert.equal(isCleanSummaryWorkspace({ ...clean, error: "offline" }), false);
});

test("partial failures preserve last successful evidence and its timestamps with an error", () => {
  const next: WorkSummaryResponse = {
    ...previous, checkedAt: "new",
    workspaces: [{ ...workspace, state: "unavailable", additions: undefined, checkedAt: "new", error: "offline" }],
    pullRequests: [{ ...previous.pullRequests[0]!, state: "unknown", connection: "error", error: "offline" }],
  };
  const retained = retainSummaryEvidence(next, previous);
  assert.equal(retained.workspaces[0]?.additions, 7);
  assert.equal(retained.workspaces[0]?.checkedAt, "old");
  assert.equal(retained.workspaces[0]?.error, "offline");
  assert.equal(retained.pullRequests[0]?.title, "PR title");
  assert.equal(retained.pullRequests[0]?.connection, "error");
  assert.equal(retainSummaryEvidence({ ...next, cwd: "/other" }, previous).workspaces[0]?.additions, undefined);
});
