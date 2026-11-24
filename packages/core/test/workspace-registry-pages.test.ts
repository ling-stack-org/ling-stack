import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceRegistryStore, resolveStoragePaths } from "../dist/index.js";

test("workspace registry pages include recorded roots without scanning the drive", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-registry-pages-"));
  const userPaths = resolveStoragePaths(join(root, "one"), { userRootDir: join(root, "user") }).user;
  const registry = createWorkspaceRegistryStore({ userPaths });
  try {
    for (const name of ["one", "two", "three"]) {
      const paths = resolveStoragePaths(join(root, name), { userRootDir: userPaths.rootDir });
      registry.registerWorkspace({ identity: paths.workspace.identity, stateLocation: paths.workspace.stateLocation, stateRoot: paths.workspace.rootDir });
    }
    const first = registry.listWorkspaces("", 2);
    const second = registry.listWorkspaces(first.at(-1)!.workspaceId, 2);
    assert.equal(first.length + second.length, 3);
    assert.equal(new Set([...first, ...second].map(entry => entry.workspaceId)).size, 3);
    assert.throws(() => registry.listWorkspaces("", 501));
  } finally { registry.close(); await rm(root, { recursive: true, force: true }); }
});
