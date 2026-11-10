import { isAbsolute, resolve } from "node:path";
import type { RunSession, RunStore } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import type { WorkflowOperationBlock } from "./workflow-operation-snapshot.js";

/** Admission only, never a permission grant. Unknown/dynamic tools are not assumed read-only. */
export function commandWriteRiskRejection(input: {
  readonly store: Pick<RunStore, "listHostCommandWriteBlockers">;
  readonly run: Pick<RunSession, "cwd">;
  readonly request: { readonly toolName: string; readonly cwd: string; readonly input: unknown };
}): WorkflowOperationBlock | undefined {
  if (["read", "grep", "find", "ls", "host_local_network_info"].includes(input.request.toolName)) return undefined;
  const paths = new Set([input.run.cwd, input.request.cwd]);
  if (isRecord(input.request.input)) {
    const cwd = input.request.input.cwd;
    if (typeof cwd === "string") paths.add(isAbsolute(cwd) ? cwd : resolve(input.request.cwd, cwd));
    if (["write", "edit"].includes(input.request.toolName) && typeof input.request.input.path === "string") {
      paths.add(resolve(input.request.cwd, input.request.input.path));
    }
  }
  try {
    for (const path of paths) {
      const blockers = input.store.listHostCommandWriteBlockers(path);
      if (blockers.length === 0) continue;
      const unconfirmed = blockers.some(blocker => blocker.state === "stop_unconfirmed");
      return { status: "blocked", code: unconfirmed ? "command_stop_unconfirmed" : "command_workspace_busy",
        reason: unconfirmed
          ? "A previous command's background stop is unconfirmed. Overlapping writes cannot resume or retry until independently resolved; read-only inspection remains available."
          : "A Host command is outstanding in this workspace. Overlapping writes must wait; restart or retry does not clear the reservation." };
    }
  } catch {
    return { status: "blocked", code: "command_write_safety_unavailable", reason: "Cannot verify durable command write safety. No write was authorized." };
  }
  return undefined;
}
