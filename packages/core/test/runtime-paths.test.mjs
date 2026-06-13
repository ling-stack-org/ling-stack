import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  resolveConfigPaths,
  resolveRuntimePaths,
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
});
