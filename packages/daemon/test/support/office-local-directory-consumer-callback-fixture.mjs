import { readOriginalAttemptExecutorGroupSnapshot } from "../../dist/runtime/attempt-execution-quiescence.js";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, digestHarnessToolValue } from "@ling-stack/core";
import { createMcpToolCallHandler } from "../../dist/features/runs/mcp.js";
import { captureMcpResultAuthority } from "../../dist/features/mcp/result-authority.js";
import { officeDocumentTools } from "../../dist/features/plugins/office-documents-generation-broker.js";
import * as officeAuthority from "../../dist/features/office-documents/office-local-authority.js";
import { executeReservedOfficeLocalArtifact } from "../../dist/features/office-documents/office-local-execution.js";

// Shared original production callback only. This helper creates no Store,
// reservation, scope, authority, native packet or replacement safety callback.
export const snapshot = f => readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup);
export const rows = f => snapshot(f).operations.map(row => f.store.getHostOperation(row.ticket.id));
export const count = (f, table) => f.store.database.prepare(`SELECT count(*) n FROM ${table}`).get().n;
export const latestV2 = f => f.store.getHostOfficeLocalDirectoryExecutionV2(f.store.database
  .prepare("SELECT execution_id FROM host_office_local_directory_v2_executions ORDER BY rowid DESC LIMIT 1").get().execution_id);

// Actual original reservation and fixed coordinator, solely to observe an
// exact repeat/reentry. No scope, cleanup fact, runtime or authority is forged.
export function reservedConsumer(f) {
  const reservation = officeAuthority.reserveOfficeLocalWriter(f.tracker, f.store, f.toolCallId, f.cwd);
  const authority = captureMcpResultAuthority(f.store, f.server.id, f.rawName).authority;
  officeAuthority.bindOfficeLocalMcpForwardAuthority(reservation, { authority,
    originalBroker: f.factory, factory: f.factory, signal: f.controller?.signal });
  const approval = officeDocumentTools.find(tool => tool.rawName === f.rawName).defaultApproval;
  const input = { tracker: f.tracker, store: f.store, toolCallId: f.toolCallId, workspaceCwd: f.cwd,
    toolName: f.rawName, input: f.request, signal: f.controller?.signal,
    requestDigest: digestHarnessToolValue({ toolName: f.rawName, input: f.request }),
    policyDigest: digestHarnessToolValue({ protocol: "ling-office-local-binary-v1", authority, approval }),
    directoryPolicyDigest: digestHarnessToolValue({ protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, authority, approval }) };
  return { reservation, invoke: () => executeReservedOfficeLocalArtifact(reservation, input) };
}

export function callback(f, { onStart, onResult } = {}) {
  const definitions = officeDocumentTools.map(tool => ({ ...tool, registeredName: `mcp_${tool.rawName}`, serverId: f.server.id }));
  const secretResolver = { resolve: () => ({ configured: false }) };
  const handler = createMcpToolCallHandler(f.store, secretResolver, f.factory, definitions,
    { runId: f.source.runId, hostOperationTracker: f.tracker, onStart, onResult });
  let sequence = 0;
  return { definitions, call(rawName = f.rawName, input = f.request, signal = f.controller?.signal) {
    return handler({ registeredName: `mcp_${rawName}`, rawName, serverId: f.server.id,
      toolCallId: `${f.toolCallId}-${++sequence}`, input, cwd: f.cwd, task: { id: "consumer", title: "Office", prompt: "Write" },
      defaultApproval: "ask", signal });
  } };
}
