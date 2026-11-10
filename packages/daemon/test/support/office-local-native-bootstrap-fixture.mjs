import fs, { closeSync, fstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { resolveConfig } from "../../dist/config.js";
import { createDefaultMcpBroker, createHostOfficeLocalGenerationFacade } from "../../dist/features/mcp/broker.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { reviewedNativeArtifact } from "./office-local-native-runtime-fixture.mjs";

/**
 * Explicit local reviewed-addon gate with genuine Supervisor/store/factory and
 * registry-owned readonly FD lifetimes. This fixture explicitly selects an empty
 * actor inventory, unlike the complete production default; its public inventory
 * check is bypassed ONLY below to reach post-registration bootstrap faults.
 * This is not actor coverage, native operation, Core safe or packaged proof.
 * No production DB or directory is used; teardown removes only created fixture
 * directories after tests have checked runtime preservation and closure.
 */
export function createNativeBootstrapFixture(t, { bypassInventory = true } = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-office-bootstrap-test-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  const store = createSqliteRunStore(cwd), supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }),
    undefined, { actorEntries: Object.freeze([]), officeLocalNativeArtifact: reviewedNativeArtifact() });
  const hostRuntime = supervisor.getRuntime(cwd, store), runtime = supervisor.getOfficeLocalNativeRuntime(cwd, store);
  const registry = supervisor.getProtectedHostStageRegistry(), now = new Date().toISOString(), id = "bootstrap-test-run";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: hostRuntime.runtimeInstanceId,
    runnerId: "pi", status: "started", now });
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: "bootstrap-test-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(id, unit.id, now); store.markRunStarted(id, now);
  const baseBroker = createDefaultMcpBroker(), factory = createHostOfficeLocalGenerationFacade({ baseBroker, workspaceCwd: cwd,
    facade: { async checkServer() { throw new Error("fixture_dispatch_not_used"); }, async listTools() { throw new Error("fixture_dispatch_not_used"); },
      async callTool() { throw new Error("fixture_dispatch_not_used"); } } });
  const input = { store, run: store.getRun(id), sourceFence: toRuntimeAttemptFence(attempt), originalBroker: factory,
    factory, rawName: "office_create_document", toolCallId: "bootstrap-test-call" };
  const stages = [], stagePaths = new Set(), closeAttempts = [];
  const originalRegister = registry.registerStage.bind(registry), originalClose = registry.closeStage.bind(registry);
  const register = t.mock.method(registry, "registerStage", value => {
    stagePaths.add(value.stagePath);
    const token = originalRegister(value); stages.push({ token, path: value.stagePath }); return token;
  });
  const close = t.mock.method(registry, "closeStage", token => { closeAttempts.push(token); return originalClose(token); });
  if (bypassInventory) t.mock.method(registry, "assertActorInventoryCurrent", () => {});
  t.after(() => {
    register.mock.restore(); close.mock.restore();
    // Do not retry any attempted/unknown original close during test teardown.
    for (const stage of stages) if (!closeAttempts.includes(stage.token)) originalClose(stage.token);
    supervisor.releaseAll(); store.close();
    for (const path of stagePaths) rmSync(path, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, store, supervisor, runtime, registry, input, stages, stagePaths, closeAttempts,
    originalRegister, originalClose, register };
}

/** Actual fs calls are observed, not replaced with synthetic descriptor results. */
export function observeBootstrapStageDescriptors(effect, { closeFault } = {}) {
  const originalCreate = fs.mkdtempSync, originalOpen = fs.openSync, originalClose = fs.closeSync,
    created = [], acquired = [], closes = [];
  fs.mkdtempSync = (...args) => {
    const path = originalCreate(...args);
    if (args[0] === "/private/tmp/ling-office-host-") created.push(path);
    return path;
  };
  fs.openSync = (...args) => {
    const fd = originalOpen(...args);
    if (typeof args[1] === "number" && (args[1] & fs.constants.O_DIRECTORY) !== 0) acquired.push({ path: args[0], fd });
    return fd;
  };
  fs.closeSync = fd => {
    if (acquired.some(value => value.fd === fd)) closes.push(fd);
    const returned = originalClose(fd);
    // A genuine entered close already released the integer, but its reply is
    // made unknown. Original tombstones must prevent closing a later reuse.
    if (closeFault?.(fd, acquired)) throw new Error("fixture_stage_close_reply_unknown");
    return returned;
  };
  syncBuiltinESMExports();
  try { return effect({ created, acquired, closes }); }
  finally {
    fs.mkdtempSync = originalCreate; fs.openSync = originalOpen; fs.closeSync = originalClose;
    syncBuiltinESMExports();
  }
}

export function assertOriginalStageDescriptorsClosed(acquired, closes) {
  for (const { fd } of acquired) {
    if (closes.filter(value => value === fd).length !== 1) throw new Error("fixture_original_close_count_invalid");
    try { fstatSync(fd); } catch (error) { if (error.code === "EBADF") continue; throw error; }
    throw new Error("fixture_original_descriptor_still_open");
  }
}

// Capture the unpatched close function; fault injection must not run on teardown
// of the deliberately reused, unrelated replacement FD.
export const closeFixtureReplacement = closeSync;
