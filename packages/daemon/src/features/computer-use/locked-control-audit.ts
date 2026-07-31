import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import {
  isLockedComputerControlAuditEventV1,
  type LockedComputerControlAuditEventV1,
} from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";

export interface LockedControlAuditPublisher {
  append(event: LockedComputerControlAuditEventV1): void;
}

/** Persist content-free lifecycle audit through the existing SQLite control-plane store. */
export function createLockedControlAuditPublisher(options: {
  readonly storeRegistry: RunStoreRegistry;
  readonly controlPlaneEvents: ControlPlaneEventHub;
}): LockedControlAuditPublisher {
  return Object.freeze({
    append(event: LockedComputerControlAuditEventV1): void {
      if (!isLockedComputerControlAuditEventV1(event) || !event.workspaceCwd) {
        throw new Error("locked_control_audit_invalid");
      }
      const cwd = event.workspaceCwd;
      const store = storeForEvent(options.storeRegistry, event, cwd);
      appendControlPlaneEvent(store, options.controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "runs",
        entityType: "locked_computer_control",
        entityId: event.runId ?? event.auditId,
        action: event.event,
        data: { ...event },
      }, event.occurredAt);
    },
  });
}

function storeForEvent(
  storeRegistry: RunStoreRegistry,
  event: LockedComputerControlAuditEventV1,
  cwd: string,
): RunStore {
  return event.runId
    ? storeRegistry.findStoreForRun(event.runId, cwd)
      ?? storeRegistry.getStore(cwd)
    : storeRegistry.getStore(cwd);
}
