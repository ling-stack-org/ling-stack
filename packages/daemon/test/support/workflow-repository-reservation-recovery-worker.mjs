import childProcess from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { createSqliteRunStore, createSqliteWorkflowIsolationStore } from "@ling-stack/core";
import { installReservationSourceHooks, reservationDist } from "./workflow-repository-reservation-recovery-support.mjs";

const input = JSON.parse(process.argv[2]);
installReservationSourceHooks();
const originalExec = DatabaseSync.prototype.exec;
let reservationCommitted = false, repositoryWriter = false, inventoryCalls = 0, freezeInputs, markerPaused = false;
let repositoryDatabase, commitFailure, commitFaultInjected = false, freezeCalls = 0, coreCommits = 0;
DatabaseSync.prototype.exec = function (sql) {
  const file = this.prepare("PRAGMA database_list").get().file;
  let reader;
  if (file === input.fencePath && sql === "COMMIT" && reservationCommitted
    && input.action === "fail-sidecar-commit" && !commitFaultInjected) {
    commitFaultInjected = true;
    reader = new DatabaseSync(input.fencePath, { readOnly: true });
    originalExec.call(reader, "BEGIN");
    reader.prepare("SELECT owner_json,state FROM repository_fence WHERE singleton=1").get();
    // Force real rollback-journal COMMIT contention without changing the committed owner/state.
    this.prepare("UPDATE repository_fence SET state='released' WHERE singleton=1").run();
    this.prepare("UPDATE repository_fence SET state='held' WHERE singleton=1").run();
  }
  let result;
  try { result = originalExec.call(this, sql); }
  catch (error) {
    if (reader) commitFailure = { repositoryWriter: this.isTransaction, coreCommits,
      state: this.prepare("SELECT state FROM repository_fence WHERE singleton=1").get().state,
      journalMode: this.prepare("PRAGMA journal_mode").get().journal_mode,
      code: error.code, errcode: error.errcode };
    throw error;
  } finally {
    if (reader) { originalExec.call(reader, "ROLLBACK"); reader.close(); }
  }
  if (file === input.fencePath) {
    repositoryDatabase = this;
    repositoryWriter = this.isTransaction;
    if (sql === "COMMIT") reservationCommitted = true;
    if (sql === "COMMIT" && input.action === "crash-after-marker") process.kill(process.pid, "SIGKILL");
    if (sql === "COMMIT" && input.pauseAfterMarker && !markerPaused) {
      markerPaused = true;
      process.send({ type: "marker", repositoryWriter });
      process.kill(process.pid, "SIGSTOP");
    }
  }
  if (file === input.paths.databasePath && sql === "COMMIT" && freezeCalls > 0
    && this.prepare("SELECT 1 FROM workflow_integration_rounds WHERE round_id=?").get(input.planInput.roundId)) {
    coreCommits++;
    if (input.action === "crash-after-freeze") process.kill(process.pid, "SIGKILL");
  }
  return result;
};

const originalExecFile = childProcess.execFile;
let paused = false;
function execFile(...args) {
  const callback = args.pop();
  return originalExecFile(...args, (error, stdout, stderr) => {
    if (!args[1].includes("worktree") || !args[1].includes("--porcelain") || !reservationCommitted) {
      return callback(error, stdout, stderr);
    }
    inventoryCalls++;
    const pause = input.pauseBudget && inventoryCalls === 2 ? "budget"
      : input.pauseInventory && inventoryCalls === 1 ? "inventory" : undefined;
    if (!pause || paused) return callback(error, stdout, stderr);
    paused = true;
    process.once("message", action => callback(action.fail ? Object.assign(new Error("inventory barrier failed"),
      { code: "fixture_reservation_inventory_failed" }) : error, stdout, stderr));
    process.send(pause === "budget" ? { type: "budget", repositoryWriter: repositoryDatabase.isTransaction,
      inventoryCalls, freezeCalls, coreCommits,
      reservationToken: JSON.parse(repositoryDatabase.prepare("SELECT owner_json FROM repository_fence WHERE singleton=1")
        .get().owner_json).reservationToken } : { type: "inventory", repositoryWriter, inventoryCalls });
  });
}
execFile[promisify.custom] = (...args) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  promise.child = child;
  return promise;
};
childProcess.execFile = execFile;
syncBuiltinESMExports();

const store = createSqliteRunStore(input.cwd, input.paths);
const fence = await import(new URL("features/workspaces/workflow-repository-fence.js", reservationDist));
try {
  if (input.action === "release") {
    fence.releaseWorkflowRepositoryFence(store, input.planInput.roundId, 1, input.inputs, undefined, input.token);
    process.send({ type: "released" });
  } else {
    const isolation = createSqliteWorkflowIsolationStore(store), originalFreeze = isolation.freezePlan;
    isolation.freezePlan = args => {
      freezeCalls++;
      freezeInputs = args.inputs;
      if (input.action === "fail-before-freeze") {
        throw Object.assign(new Error("freeze barrier failed"), { code: "fixture_reservation_freeze_failed" });
      }
      return originalFreeze.call(isolation, args);
    };
    const { planWorkflowIsolatedRound } = await import(new URL("features/channels/workflow-isolation-planning.js", reservationDist));
    const result = await planWorkflowIsolatedRound({ ...input.planInput, store });
    process.send({ type: "planned", roundId: result.round.roundId, inventoryCalls, freezeCalls, coreCommits });
  }
} catch (error) {
  process.send({ type: "error", code: error.code, message: error.message, inputs: freezeInputs,
    causeCode: error.cause?.code, causeErrcode: error.cause?.errcode, commitFailure, freezeCalls, coreCommits });
} finally {
  store.close();
  process.disconnect();
}
