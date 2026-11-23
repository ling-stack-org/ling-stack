import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceChangesResponse } from "@ling-stack/contracts";
import { workspaceFileChange, workspaceRelativePath } from "../src/features/workspace/right-dock/workspace-file-change.ts";

const response: WorkspaceChangesResponse = {
  cwd: "/repo/sub", repoRoot: "/repo", state: "dirty", additions: 1, deletions: 1,
  totalFileCount: 2, truncated: false, checkedAt: "2026-01-01T00:00:00Z",
  files: [
    { path: "sub/one.ts", kind: "modified", staged: true, unstaged: true, untracked: false, additions: 1, deletions: 1, diff: "patch", truncated: false },
    { path: "sub/new.ts", originalPath: "sub/old.ts", kind: "renamed", staged: true, unstaged: false, untracked: false, additions: 0, deletions: 0, truncated: false },
  ],
};
test("matches exact repository-relative file and rename paths from a nested cwd", () => {
  assert.equal(workspaceFileChange(response, "/repo/sub", "one.ts")?.path, "sub/one.ts");
  assert.equal(workspaceFileChange(response, "/repo/sub", "/repo/sub/old.ts")?.path, "sub/new.ts");
  assert.equal(workspaceFileChange(response, "/repo/sub", "../sub/one.ts")?.path, "sub/one.ts");
  assert.equal(workspaceFileChange(response, "/repo/sub", "elsewhere/one.ts"), undefined);
});
test("refuses paths outside the root or with a misleading root prefix", () => {
  assert.equal(workspaceRelativePath(response, "/repo/sub", "../../outside.ts"), undefined);
  assert.equal(workspaceRelativePath(response, "/repo/sub", "/repo-other/sub/one.ts"), undefined);
  assert.equal(workspaceRelativePath(response, "relative", "one.ts"), undefined);
  assert.equal(workspaceRelativePath(response, "/repo/sub", "one\\name.ts"), undefined);
});
test("matches Windows paths without conflating distinct files", () => {
  const windows = { ...response, cwd: "C:\\Repo\\sub", repoRoot: "C:\\Repo" };
  assert.equal(workspaceFileChange(windows, windows.cwd, "ONE.ts")?.path, "sub/one.ts");
  assert.equal(workspaceRelativePath(windows, windows.cwd, "D:\\Repo\\sub\\one.ts"), undefined);
  const network = { ...response, cwd: "\\\\server\\share\\repo\\sub", repoRoot: "\\\\server\\share\\repo" };
  assert.equal(workspaceFileChange(network, network.cwd, "one.ts")?.path, "sub/one.ts");
});
