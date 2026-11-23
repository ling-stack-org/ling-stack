import { automationDefinitionDigestInput, automationEventDigest, automationEventRunKey,
  type AutomationDefinition, type AutomationEventEnvelope, type AutomationRun, type RunStore } from "@ling-stack/core";
import type { NativeWorkIntakeReceipt } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { recoveryBlocked } from "../../server/app-server-recovery.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { NativeWorkIntake } from "../work-items/native-intake.js";
import type { RunAutomationInput, RunAutomationResult } from "./run.js";

export interface NativeAutomationIntakeDispatch {
  readonly automationRun: AutomationRun;
  readonly assertCurrent: () => void;
  readonly event?: {
    readonly envelope: AutomationEventEnvelope;
    readonly dispatchId: string;
    readonly assertCurrent: () => void;
  };
}

export function prepareNativeAutomationIntakeDispatch(
  store: RunStore, intake: NativeWorkIntake, receipt: NativeWorkIntakeReceipt,
  automationRun: AutomationRun, assertOwner: () => void,
): NativeAutomationIntakeDispatch {
  const record = intake.read(store, receipt.receiptId);
  const dispatchId = record?.eventDispatchId;
  const job = dispatchId ? store.getAutomationEventDispatch(dispatchId) : undefined;
  const envelope = job ? store.getAutomationEvent(job.eventId) : undefined;
  const assertCurrent = () => {
    assertOwner();
    intake.assertCurrent(store, receipt, receipt.outcome === "accepted");
    const current = store.getAutomationDefinition(receipt.sourceScope);
    if (current?.status !== "enabled" || automationEventDigest(automationDefinitionDigestInput(current)) !== receipt.sourceRevision) {
      throw new HttpError(409, "native_intake_source_changed", "The automation definition changed after intake.");
    }
    if (automationRun.triggerType === "event") {
      const currentJob = dispatchId ? store.getAutomationEventDispatch(dispatchId) : undefined;
      const source = currentJob && store.getAutomationEventSource(currentJob.sourceId);
      if (!currentJob || currentJob.automationId !== automationRun.automationId || source?.enabled !== true
        || source.revision !== currentJob.sourceRevision || !envelope || envelope.sourceId !== currentJob.sourceId
        || automationRun.idempotencyKey !== automationEventRunKey(currentJob.id)) {
        throw new HttpError(409, "native_intake_event_authority_changed", "The signed event dispatch is unavailable or changed.");
      }
      if (currentJob.status === "queued" || currentJob.status === "dispatching") {
        throw new HttpError(409, "native_intake_event_binding_pending", "The signed event owner is still recording its occurrence.");
      }
      if (currentJob.status !== "linked" || currentJob.automationRunId !== automationRun.id) {
        throw new HttpError(409, "native_intake_event_authority_changed", "The signed event owner changed.");
      }
    }
  };
  assertCurrent();
  return {
    automationRun, assertCurrent, ...(dispatchId && envelope ? { event: { envelope, dispatchId, assertCurrent } } : {}),
  };
}

export function acceptAutomationIntakeSuggestion(store: RunStore, intake: NativeWorkIntake,
  automation: AutomationDefinition, receiptId: string): { automationRun: AutomationRun; intakeReceipt: NativeWorkIntakeReceipt } {
  const receipt = intake.read(store, receiptId)?.receipt;
  const automationRun = receipt?.sourceKind === "automation_run" && receipt.sourceScope === automation.id
    ? store.getAutomationRun(receipt.executionId) : undefined;
  if (!receipt || receipt.outcome !== "suggested" || !automationRun || automationRun.automationId !== automation.id) {
    throw new HttpError(404, "native_intake_unavailable", "The proposed Automation occurrence is unavailable.");
  }
  if (receipt.dispatch) return { automationRun, intakeReceipt: receipt };
  prepareNativeAutomationIntakeDispatch(store, intake, receipt, automationRun, () => {});
  if (automationRun.status !== "skipped" || automationRun.runId) {
    throw new HttpError(409, "native_intake_source_changed", "The proposed Automation occurrence has already changed.");
  }
  intake.settle(store, receiptId, { status: "pending" });
  return { automationRun, intakeReceipt: intake.read(store, receiptId)!.receipt };
}

export async function dispatchNativeAutomationIntake(
  store: RunStore, stores: RunStoreRegistry, intake: NativeWorkIntake, signal: AbortSignal,
  run: (input: Pick<RunAutomationInput, "cwd" | "automationId" | "request" | "intakeDispatch" | "event">) => Promise<RunAutomationResult>,
): Promise<void> {
  for (const receipt of store.listNativeWorkIntakeReceipts("automation_run", undefined, 4,
    new Date(Date.now() - 1000).toISOString())) {
    signal.throwIfAborted();
    const native = store.getAutomationRun(receipt.executionId);
    if (native?.runId) {
      intake.settle(store, receipt.receiptId, { status: "admitted", runId: native.runId });
      continue;
    }
    if (!native || native.status !== "skipped" && native.status !== "queued") {
      intake.settle(store, receipt.receiptId, { status: "held", reasonCode: "native_intake_source_changed" });
      continue;
    }
    try {
      const dispatch = prepareNativeAutomationIntakeDispatch(store, intake, receipt, native, () => {
        signal.throwIfAborted();
        if (stores.recoveryBlocksDispatch(store.paths.cwd)) throw recoveryBlocked();
      });
      const record = intake.read(store, receipt.receiptId);
      const result = await run({
        cwd: store.paths.cwd, automationId: native.automationId, intakeDispatch: dispatch, event: dispatch.event,
        request: { idempotencyKey: native.idempotencyKey, triggerType: native.triggerType, scheduledFor: native.scheduledFor,
          monitorSnapshot: record?.monitorSnapshot },
      });
      const runId = result.automationRun.id === native.id ? result.automationRun.runId : undefined;
      const latest = store.getAutomationRun(native.id);
      intake.settle(store, receipt.receiptId, runId ? { status: "admitted", runId }
        : latest?.status === "failed" ? { status: "held", reasonCode: "native_intake_run_not_admitted" }
          : { status: "pending", reasonCode: "native_intake_execution_busy" });
    } catch (error) {
      signal.throwIfAborted();
      const reasonCode = error instanceof HttpError ? error.code : "native_intake_dispatch_failed";
      intake.settle(store, receipt.receiptId, {
        status: ["native_intake_quiet_hours", "native_intake_event_binding_pending"].includes(reasonCode) ? "pending" : "held", reasonCode,
      });
    }
  }
}
