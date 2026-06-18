import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createWorkspaceRegistryStore,
  resolveConfigPaths,
  resolveRuntimePaths,
  resolveStoragePaths,
  resolveUserConfigPaths,
} from "../dist/index.js";

test("resolveRuntimePaths returns canonical workspace .ling-stack paths", () => {
  const cwd = resolve("/tmp/ling-stack-runtime-paths-workspace");
  const paths = resolveRuntimePaths(cwd);

  assert.equal(paths.cwd, cwd);
  assert.equal(paths.rootDir, resolve(cwd, ".ling-stack"));
  assert.equal(paths.configPath, resolve(cwd, ".ling-stack", "config.json"));
  assert.equal(paths.databasePath, resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
  assert.equal(paths.runtimeSettingsPath, resolve(cwd, ".ling-stack", "runtime-settings.json"));
  assert.equal(paths.sessionsDir, resolve(cwd, ".ling-stack", "sessions"));
  assert.equal(paths.artifactsDir, resolve(cwd, ".ling-stack", "artifacts"));
  assert.equal(paths.attachmentsDir, resolve(cwd, ".ling-stack", "attachments"));
  assert.equal(paths.logsDir, resolve(cwd, ".ling-stack", "logs"));
  assert.equal(paths.piDir, resolve(cwd, ".ling-stack", "pi"));
  assert.equal(paths.pluginsDir, resolve(cwd, ".ling-stack", "plugins"));
  assert.equal(paths.pluginCacheDir, resolve(cwd, ".ling-stack", "plugins", "cache"));
  assert.equal(paths.worktreesDir, resolve(cwd, ".ling-stack", "worktrees"));
  assert.equal(paths.memoryExportsDir, resolve(cwd, ".ling-stack", "exports", "memory"));
  assert.equal(paths.stateLocation, "repo-local");
  assert.equal(paths.identity.canonicalCwd, cwd);
  assert.match(paths.identity.workspaceId, /^workspace_[0-9a-f]{16}$/);
});

test("resolveUserConfigPaths returns default user .ling-stack paths", () => {
  const homeDir = resolve("/tmp/ling-stack-home");
  const paths = resolveUserConfigPaths({ homeDir, env: {} });

  assert.equal(paths.rootDir, resolve(homeDir, ".ling-stack"));
  assert.equal(paths.configPath, resolve(homeDir, ".ling-stack", "config.json"));
  assert.equal(paths.settingsPath, resolve(homeDir, ".ling-stack", "settings.json"));
  assert.equal(paths.providersDir, resolve(homeDir, ".ling-stack", "providers"));
  assert.equal(paths.providerProfilesPath, resolve(homeDir, ".ling-stack", "providers", "profiles.json"));
  assert.equal(paths.pluginsDir, resolve(homeDir, ".ling-stack", "plugins"));
  assert.equal(paths.pluginCacheDir, resolve(homeDir, ".ling-stack", "plugins", "cache"));
  assert.equal(paths.stateDir, resolve(homeDir, ".ling-stack", "state"));
  assert.equal(paths.recentWorkspacesPath, resolve(homeDir, ".ling-stack", "state", "recent-workspaces.json"));
  assert.equal(paths.daemonStatePath, resolve(homeDir, ".ling-stack", "state", "daemon.json"));
  assert.equal(paths.globalDatabasePath, resolve(homeDir, ".ling-stack", "global.sqlite"));
  assert.equal(paths.workspacesDir, resolve(homeDir, ".ling-stack", "workspaces"));
  assert.equal(paths.logsDir, resolve(homeDir, ".ling-stack", "logs"));
});

test("resolveUserConfigPaths allows explicit LING_STACK_HOME root", () => {
  const userRootDir = resolve("/tmp/ling-stack-custom-home");
  const paths = resolveUserConfigPaths({
    homeDir: resolve("/tmp/ignored-home"),
    env: { LING_STACK_HOME: userRootDir },
  });

  assert.equal(paths.rootDir, userRootDir);
  assert.equal(paths.configPath, resolve(userRootDir, "config.json"));
});

test("resolveConfigPaths returns user and workspace layers", () => {
  const cwd = resolve("/tmp/ling-stack-config-paths-workspace");
  const userRootDir = resolve("/tmp/ling-stack-config-paths-user");
  const paths = resolveConfigPaths(cwd, { env: { LING_STACK_HOME: userRootDir } });

  assert.equal(paths.cwd, cwd);
  assert.equal(paths.user.rootDir, userRootDir);
  assert.equal(paths.workspace.rootDir, resolve(cwd, ".ling-stack"));
  assert.equal(paths.user.globalDatabasePath, resolve(userRootDir, "global.sqlite"));
});

test("resolveStoragePaths supports user-data-dir workspace state roots", () => {
  const cwd = resolve("/tmp/ling-stack-storage-paths-workspace");
  const userRootDir = resolve("/tmp/ling-stack-storage-paths-user");
  const paths = resolveStoragePaths(cwd, {
    env: { LING_STACK_HOME: userRootDir },
    workspaceStateLocation: "user-data-dir",
  });

  assert.equal(paths.cwd, cwd);
  assert.equal(paths.workspace.stateLocation, "user-data-dir");
  assert.equal(paths.workspace.rootDir, resolve(userRootDir, "workspaces", paths.workspace.identity.workspaceId));
  assert.equal(paths.workspace.databasePath, resolve(paths.workspace.rootDir, "ling-stack.sqlite"));
  assert.equal(paths.workspace.identity.canonicalCwd, cwd);
});

test("resolveStoragePaths reads repo-local user-data-dir pointer config", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "ling-stack-storage-pointer-"));
  try {
    const cwd = resolve(parent, "workspace");
    const userRootDir = resolve(parent, "user");
    await mkdir(resolve(cwd, ".ling-stack"), { recursive: true });
    const explicit = resolveStoragePaths(cwd, {
      env: { LING_STACK_HOME: userRootDir },
      workspaceStateLocation: "user-data-dir",
    });
    await writeFile(resolve(cwd, ".ling-stack", "config.json"), JSON.stringify({
      schemaVersion: 1,
      product: "ling-stack",
      workspaceId: explicit.workspace.identity.workspaceId,
      workspaceStateLocation: "user-data-dir",
      stateRoot: explicit.workspace.rootDir,
    }), "utf8");

    const detected = resolveStoragePaths(cwd, { env: { LING_STACK_HOME: userRootDir } });

    assert.equal(detected.workspace.stateLocation, "user-data-dir");
    assert.equal(detected.workspace.rootDir, explicit.workspace.rootDir);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("resolveStoragePaths falls back to global workspace registry state location", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "ling-stack-storage-registry-"));
  try {
    const cwd = resolve(parent, "workspace");
    const userRootDir = resolve(parent, "user");
    const explicit = resolveStoragePaths(cwd, {
      env: { LING_STACK_HOME: userRootDir },
      workspaceStateLocation: "user-data-dir",
    });
    const registry = createWorkspaceRegistryStore({ userPaths: explicit.user });
    try {
      registry.registerWorkspace({
        identity: explicit.workspace.identity,
        stateLocation: "user-data-dir",
        stateRoot: explicit.workspace.rootDir,
        now: "2026-06-18T00:00:00.000Z",
      });
    } finally {
      registry.close();
    }

    const detected = resolveStoragePaths(cwd, { env: { LING_STACK_HOME: userRootDir } });

    assert.equal(detected.workspace.stateLocation, "user-data-dir");
    assert.equal(detected.workspace.rootDir, explicit.workspace.rootDir);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("workspace registry stores resolved workspace state roots", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "ling-stack-registry-test-"));
  try {
    const cwd = resolve(parent, "workspace");
    const userRootDir = resolve(parent, "user");
    const paths = resolveStoragePaths(cwd, { env: { LING_STACK_HOME: userRootDir } });
    const registry = createWorkspaceRegistryStore({ userPaths: paths.user });
    try {
      const registered = registry.registerWorkspace({
        identity: paths.workspace.identity,
        stateLocation: paths.workspace.stateLocation,
        stateRoot: paths.workspace.rootDir,
        now: "2026-06-18T00:00:00.000Z",
      });

      assert.equal(registered.workspaceId, paths.workspace.identity.workspaceId);
      assert.equal(registered.canonicalCwd, cwd);
      assert.equal(registered.stateLocation, "repo-local");
      assert.equal(registered.stateRoot, resolve(cwd, ".ling-stack"));
      assert.deepEqual(registry.getWorkspaceByCanonicalCwd(cwd), registered);
    } finally {
      registry.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
