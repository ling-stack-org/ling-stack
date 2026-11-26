import type {
  WorkIntakeBudget, NativeWorkIntakeReceipt,
  NativeWorkIntakeSourceKind, WorkItemPriority,
} from "@ling-stack/contracts";
import type { AutomationMonitorSnapshotBody } from "./automation-monitor-types.js";
import type { ControlPlaneEvent } from "./run-types.js";

export interface NativeWorkIntakePolicyBasis {
  readonly policyId: string;
  readonly policyRevision: string;
  readonly sourceKind: NativeWorkIntakeSourceKind;
  readonly sourceScope: string;
  readonly mode: "manual" | "suggest" | "auto_start";
  readonly enabled: boolean;
  readonly priority: WorkItemPriority;
  readonly budget?: WorkIntakeBudget;
  readonly quiet: boolean;
}

export interface NativeWorkIntakeInput {
  readonly policy: NativeWorkIntakePolicyBasis;
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly blocker?: string;
  readonly monitorSnapshot?: AutomationMonitorSnapshotBody;
  readonly eventDispatchId?: string;
}

export interface NativeWorkIntakeRecord {
  readonly receipt: NativeWorkIntakeReceipt;
  readonly retryReceiptId?: string;
  readonly monitorSnapshot?: AutomationMonitorSnapshotBody;
  readonly eventDispatchId?: string;
}

export interface NativeWorkIntakeResult<T> {
  readonly execution: T;
  readonly receipt: NativeWorkIntakeReceipt;
  readonly event?: ControlPlaneEvent;
}
