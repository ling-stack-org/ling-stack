import { parentPort, workerData } from "node:worker_threads";
import { createSqliteRunStore } from "../../dist/index.js";

const store = createSqliteRunStore(workerData.cwd);
parentPort.once("message", () => {
  try {
    const result = workerData.approve
      ? store.approveApprovalRequest(workerData.id, { decisionKind: "approve_permission_scope" }, workerData.now)
      : store.denyApprovalRequest(workerData.id, {}, workerData.now);
    parentPort.postMessage({ status: result.status });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { store.close(); parentPort.close(); }
});
parentPort.postMessage({ ready: true });
