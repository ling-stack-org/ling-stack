import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS,
  resolveSharedAgentsSkillSourceRoots,
} from "../dist/index.js";

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function summarize(roots) {
  return roots.map(({ id, rootPath, sourceKind, label }) => ({ id, rootPath, sourceKind, label }));
}

test("shared agents roots auto-detect the project and user .agents/skills directories", async () => {
  await withTempDir("ling-shared-roots-", async (root) => {
    const workspaceRoot = join(root, "workspace");
    const homeDir = join(root, "home");
    await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
    await mkdir(join(homeDir, ".agents", "skills"), { recursive: true });

    const roots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot, homeDir });

    assert.deepEqual(summarize(roots), [
      {
        id: SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project,
        rootPath: resolve(workspaceRoot, ".agents", "skills"),
        sourceKind: "workspace-skill-directory",
        label: "Project shared .agents skill root",
      },
      {
        id: SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.user,
        rootPath: resolve(homeDir, ".agents", "skills"),
        sourceKind: "workspace-skill-directory",
        label: "User shared .agents skill root",
      },
    ]);
  });
});

test("shared agents roots only include directories that exist", async () => {
  await withTempDir("ling-shared-roots-missing-", async (root) => {
    const workspaceRoot = join(root, "workspace");
    const homeDir = join(root, "home");
    await mkdir(workspaceRoot, { recursive: true });

    assert.deepEqual(await resolveSharedAgentsSkillSourceRoots({ workspaceRoot, homeDir }), []);
  });
});

test("shared agents roots honor explicit include flags", async () => {
  await withTempDir("ling-shared-roots-flags-", async (root) => {
    const workspaceRoot = join(root, "workspace");
    const homeDir = join(root, "home");
    await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
    await mkdir(join(homeDir, ".agents", "skills"), { recursive: true });

    const projectOnly = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot, homeDir, includeUserRoot: false });
    assert.deepEqual(projectOnly.map((entry) => entry.id), [SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project]);

    const userOnly = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot, homeDir, includeProjectRoot: false });
    assert.deepEqual(userOnly.map((entry) => entry.id), [SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.user]);

    const none = await resolveSharedAgentsSkillSourceRoots({
      workspaceRoot,
      homeDir,
      includeProjectRoot: false,
      includeUserRoot: false,
    });
    assert.deepEqual(none, []);
  });
});

test("shared agents roots dedupe the same directory and keep the project root first", async () => {
  await withTempDir("ling-shared-roots-dedupe-", async (root) => {
    await mkdir(join(root, ".agents", "skills"), { recursive: true });

    const roots = await resolveSharedAgentsSkillSourceRoots({ workspaceRoot: root, homeDir: root });

    assert.deepEqual(roots.map((entry) => entry.id), [SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.project]);
    assert.equal(roots[0].rootPath, resolve(root, ".agents", "skills"));
    assert.equal(roots[0].label, "Project shared .agents skill root");
  });
});

test("shared agents roots skip the project root when no workspace root is known", async () => {
  await withTempDir("ling-shared-roots-no-workspace-", async (root) => {
    const homeDir = join(root, "home");
    await mkdir(join(homeDir, ".agents", "skills"), { recursive: true });

    const roots = await resolveSharedAgentsSkillSourceRoots({ homeDir });

    assert.deepEqual(roots.map((entry) => entry.id), [SHARED_AGENTS_SKILL_SOURCE_ROOT_IDS.user]);
  });
});
