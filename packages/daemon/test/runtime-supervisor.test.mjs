import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

test("runtime supervisor releases locks from resolved workspace state root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-lock-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-runtime-lock-user-"));
  const paths = resolveStoragePaths(cwd, {
    userRootDir: userRoot,
    workspaceStateLocation: "user-data-dir",
  }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  const supervisor = new RuntimeSupervisor({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    transports: {
      providerWebSocketFallback: true,
      localWebSocketRpc: true,
    },
    channels: {},
  });
  try {
    supervisor.getRuntime(cwd, store);
    const lockPath = join(paths.rootDir, "runtime.lock");
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(join(cwd, ".ling-stack", "runtime.lock")), false);

    supervisor.releaseAll();

    assert.equal(existsSync(lockPath), false);
  } finally {
    supervisor.releaseAll();
    store.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});
