import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanOwnedStorage } from "../dist/features/settings/device-storage/scanner.js";

test("device storage counts owned files once without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-storage-scan-"));
  try {
    const userRoot = join(root, "user"), workspaceRoot = join(userRoot, "workspaces", "one");
    const sessions = join(workspaceRoot, "sessions"), plugins = join(userRoot, "plugins"), worktree = join(root, "managed-worktree");
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(plugins, { recursive: true }), mkdir(worktree)]);
    await writeFile(join(sessions, "chat"), Buffer.alloc(11));
    await link(join(sessions, "chat"), join(sessions, "same-inode"));
    await writeFile(join(plugins, "plugin"), Buffer.alloc(7));
    await writeFile(join(worktree, "file"), Buffer.alloc(13));
    await symlink(worktree, join(sessions, "foreign-link"));
    const result = await scanOwnedStorage({ scope: "all", userRoot, workspaceRoots: [workspaceRoot], worktreeRoots: [worktree] });
    assert.equal(result.categories.find(item => item.category === "conversations")?.knownBytes, 11);
    assert.equal(result.categories.find(item => item.category === "plugins")?.knownBytes, 7);
    assert.equal(result.categories.find(item => item.category === "worktrees")?.knownBytes, 13);
    assert.equal(result.knownBytes, 31);
    assert.equal(result.categories.find(item => item.category === "browser")?.status, "unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device storage reports incomplete paths and aborted scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-storage-partial-"));
  try {
    const controller = new AbortController(); controller.abort();
    const result = await scanOwnedStorage({ scope: "current", workspaceRoots: [root, join(root, "missing")], worktreeRoots: [] }, { signal: controller.signal });
    assert.equal(result.complete, false);
    assert.equal(result.categories.find(item => item.category === "other")?.status, "partial");
  } finally { await rm(root, { recursive: true, force: true }); }
});
