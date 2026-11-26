import { automationDefinitionDigestInput, automationEventDigest, nativeTaskIntakeRevision, nativeWorkIntakeReceiptId,
  nativeWorkIntakeRetryReceiptId, readOnlyRunTools, type AutomationDefinition, type ControlPlaneEvent, type NativeWorkIntakeRecord, type RunStore } from "@ling-stack/core";
import type { NativeWorkIntakeReceipt, NativeWorkIntakeSourceKind, RetryNativeWorkIntakeRequest } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { ResolvedDaemonConfig } from "../../config.js";
import { nativeWorkIntakePolicy, type NativeWorkIntakePolicy } from "../../server/app-server-native-intake-config.js";
import { isIntakeQuiet } from "./intake-policy.js";
import { assertChannelWorkspaceReady } from "../channels/workspace.js";
import { getChannelPlanModeBlocker } from "../channels/plan-mode-guard.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import type { RunRequest } from "../runs/schemas.js";
import { materializeTaskAttachmentsForPrompt } from "../tasks/task-attachments.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";

export class NativeWorkIntake {
  constructor(private readonly config: Pick<ResolvedDaemonConfig, "appServerNativeIntake">,
    private readonly events: ControlPlaneEventHub) {}

  policy(store: RunStore, sourceKind: NativeWorkIntakeSourceKind, sourceScope: string): NativeWorkIntakePolicy | undefined {
    return this.config.appServerNativeIntake.find(policy => policy.workspaceRoot === store.paths.cwd
      && policy.sourceKind === sourceKind && policy.sourceScope === sourceScope);
  }

  manualPolicy(store: RunStore, sourceKind: NativeWorkIntakeSourceKind, sourceScope: string): NativeWorkIntakePolicy {
    return nativeWorkIntakePolicy({ workspaceRoot: store.paths.cwd, sourceKind, sourceScope });
  }

  basis(policy: NativeWorkIntakePolicy, now: string) {
    return { ...policy, quiet: isIntakeQuiet(policy.quietHours, new Date(now)) };
  }

  publish(event?: ControlPlaneEvent): void {
    if (event) this.events.publish(trimOversizedEvent(event));
  }

  read(store: RunStore, receiptId: string): NativeWorkIntakeRecord | undefined {
    return store.getAppServerState("native_intake_receipt", receiptId)?.payload as NativeWorkIntakeRecord | undefined;
  }

  acceptTaskSuggestion(store: RunStore, receipt: NativeWorkIntakeReceipt): NativeWorkIntakeReceipt {
    if (receipt.dispatch) return receipt;
    this.assertCurrent(store, receipt, false);
    const task = store.getTask(receipt.executionId);
    const channel = task && store.getChannel(task.channelId);
    if (!task || channel?.id !== receipt.sourceScope || channel.status !== "active"
      || nativeTaskIntakeRevision(task) !== receipt.sourceRevision) {
      throw new HttpError(409, "native_intake_source_changed", "The suggested Task or its channel changed.");
    }
    if (task.currentRunId) {
      if (!isTaskRunForReceipt(store, receipt, task.currentRunId)) {
        throw new HttpError(409, "native_intake_dispatch_reconciliation_required", "The Task's current Run could not be confirmed.");
      }
      this.settle(store, receipt.receiptId, { status: "admitted", runId: task.currentRunId });
    } else if (task.status === "todo") {
      this.settle(store, receipt.receiptId, { status: "pending" });
    } else {
      throw new HttpError(409, "native_intake_source_changed", "The suggested Task is unavailable to start.");
    }
    return this.read(store, receipt.receiptId)!.receipt;
  }

  retry(store: RunStore, request: RetryNativeWorkIntakeRequest): NativeWorkIntakeReceipt {
    const receipt = this.read(store, request.receiptId)?.receipt;
    if (!receipt) throw new HttpError(404, "native_intake_unavailable", "The source occurrence is unavailable.");
    const retryId = nativeWorkIntakeRetryReceiptId(receipt.sourceKind, receipt.sourceEventId, receipt.receiptId, request.idempotencyKey);
    const retained = this.read(store, retryId)?.receipt;
    if (retained?.previousReceiptId === receipt.receiptId) return retained;
    const policy = this.policy(store, receipt.sourceKind, receipt.sourceScope);
    if (!policy || policy.mode === "manual") {
      throw new HttpError(409, "native_intake_authority_changed", "The source must have a current intake policy.");
    }
    const channel = receipt.sourceKind === "channel_task" ? store.getChannel(receipt.sourceScope) : undefined;
    const automation = receipt.sourceKind === "automation_run" ? store.getAutomationDefinition(receipt.sourceScope) : undefined;
    if (receipt.sourceKind === "channel_task" && !channel || receipt.sourceKind === "automation_run"
      && (!automation || automationEventDigest(automationDefinitionDigestInput(automation)) !== receipt.sourceRevision)) {
      throw new HttpError(409, "native_intake_source_changed", "The source occurrence changed before re-evaluation.");
    }
    const now = new Date().toISOString();
    try {
      const result = store.retryNativeWorkIntake(request, {
        policy: this.basis(policy, now), sourceEventId: receipt.sourceEventId, sourceRevision: receipt.sourceRevision,
        blocker: channel && channel.status !== "active" ? "channel_unavailable" : undefined,
      }, now, store.paths.cwd);
      this.publish(result.event);
      return result.receipt;
    } catch (error) {
      if (error instanceof Error && error.message === "native_intake_retry_conflict") {
        throw new HttpError(409, error.message, "Re-evaluate the latest eligible receipt for this occurrence.");
      }
      throw error;
    }
  }

  reconsiderMonitor(store: RunStore, automation: AutomationDefinition, prior: NativeWorkIntakeReceipt, now: string): NativeWorkIntakeReceipt {
    let record = this.read(store, prior.receiptId);
    while (record?.retryReceiptId) record = this.read(store, record.retryReceiptId);
    const receipt = record?.receipt ?? prior;
    const policy = this.policy(store, "automation_run", automation.id);
    if (receipt.outcome !== "suppressed" || !policy?.enabled || policy.mode !== "auto_start"
      || receipt.sourceRevision !== automationEventDigest(automationDefinitionDigestInput(automation))) return receipt;
    const basis = this.basis(policy, now);
    if (basis.quiet || store.listAutomationRuns({ automationId: automation.id, limit: 100 }).some(run =>
      run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval")) return receipt;
    const result = store.retryNativeWorkIntake({ receiptId: receipt.receiptId, idempotencyKey: "monitor-automatic-admission" }, {
      policy: basis, sourceEventId: receipt.sourceEventId, sourceRevision: receipt.sourceRevision,
    }, now, store.paths.cwd, true);
    this.publish(result.event);
    return result.receipt;
  }

  assertCurrent(store: RunStore, receipt: NativeWorkIntakeReceipt, automatic: boolean): void {
    const policy = this.policy(store, receipt.sourceKind, receipt.sourceScope);
    if (policy?.enabled !== true || policy.policyRevision !== receipt.policyRevision
      || automatic && policy.mode !== "auto_start") {
      throw new HttpError(409, "native_intake_authority_changed", "The source intake policy is unavailable or has changed.");
    }
    if (automatic && isIntakeQuiet(policy.quietHours, new Date())) {
      throw new HttpError(409, "native_intake_quiet_hours", "The source is in its configured quiet hours.");
    }
    const item = receipt.workItemId ? store.getWorkItem(receipt.workItemId) : undefined;
    if (!item || item.linkedExecution?.id !== receipt.executionId || item.linkedExecution.kind !== receipt.sourceKind
      || item.control.state !== "active" || ["done", "archived", "cancelled", "superseded"].includes(item.status)
      || item.holds.some(hold => hold.blocksNewAdmission && hold.id !== `work_item_source_owner:${item.id}`)) {
      throw new HttpError(409, "native_intake_work_item_held", "The native execution's work item is unavailable or held.");
    }
  }

  settle(store: RunStore, receiptId: string, dispatch: NonNullable<NativeWorkIntakeReceipt["dispatch"]>): void {
    const state = store.getAppServerState("native_intake_receipt", receiptId);
    if (!state) return;
    const record = state.payload as NativeWorkIntakeRecord;
    if (record.receipt.dispatch?.status === "admitted"
      || dispatch.status === "pending" && record.receipt.dispatch?.status === "held") return;
    const now = new Date().toISOString();
    const workItemId = record.receipt.workItemId;
    const event = workItemId && (dispatch.status !== "pending" || !record.receipt.dispatch) ? {
      workspaceId: record.receipt.workspaceId, cwd: store.paths.cwd, domain: "work_items" as const,
      entityType: "work_item", entityId: workItemId, action: "work_item.intake.dispatch.updated",
      data: { workItemId, receiptId, status: dispatch.status, reasonCode: dispatch.reasonCode },
    } : undefined;
    this.publish(store.putAppServerState({
      kind: "native_intake_receipt", recordId: receiptId, expectedRevision: state.revision,
      payload: { ...record, receipt: { ...record.receipt, dispatch } },
    }, now, event)?.event);
  }

  async dispatchTasks(store: RunStore, signal: AbortSignal, imageVisionSummarizer: LingImageVisionSummarizer | undefined,
    start: (request: RunRequest, assertCurrent: () => void) => Promise<string | undefined>): Promise<void> {
    for (const receipt of store.listNativeWorkIntakeReceipts("channel_task", undefined, 4, new Date(Date.now() - 1_000).toISOString())) {
      signal.throwIfAborted();
      const task = store.getTask(receipt.executionId);
      const key = `native-intake:${nativeWorkIntakeReceiptId("channel_task", receipt.sourceEventId)}`;
      const workUnit = store.findWorkUnitByIdempotency({ kind: "task_run", ownerType: "task", ownerId: receipt.executionId, idempotencyKey: key });
      const retainedRunId = workUnit?.linkedRunId ?? (task?.channelId === receipt.sourceScope ? task.currentRunId : undefined);
      if (retainedRunId && isTaskRunForReceipt(store, receipt, retainedRunId)) {
        this.settle(store, receipt.receiptId, { status: "admitted", runId: retainedRunId });
        continue;
      }
      if (workUnit || retainedRunId) {
        this.settle(store, receipt.receiptId, { status: "held", reasonCode: "native_intake_dispatch_reconciliation_required" });
        continue;
      }
      try {
        const channel = task && store.getChannel(task.channelId);
        const workspace = channel && assertChannelWorkspaceReady(channel, store.paths.cwd);
        const providerPresetId = channel?.defaultProviderPresetId;
        const assertCurrent = () => {
          signal.throwIfAborted();
          this.assertCurrent(store, receipt, receipt.outcome === "accepted");
          const currentTask = store.getTask(receipt.executionId);
          const currentChannel = currentTask && store.getChannel(currentTask.channelId);
          const ownClaim = currentTask?.status === "claimed"
            && store.findStateTransitionByIdempotency("task", currentTask.id, key) !== undefined;
          if (!currentTask || currentTask.status !== "todo" && !ownClaim
            || nativeTaskIntakeRevision(currentTask) !== receipt.sourceRevision
            || currentChannel?.id !== receipt.sourceScope || currentChannel.status !== "active"
            || currentChannel.defaultProviderPresetId !== providerPresetId || currentChannel.boundPath !== channel?.boundPath
            || currentChannel.defaultTeammateId !== channel?.defaultTeammateId
            || JSON.stringify(currentChannel.allowedTools) !== JSON.stringify(channel?.allowedTools)
            || getChannelPlanModeBlocker(store, currentChannel.id)) {
            throw new HttpError(409, "native_intake_source_changed", "The source task or channel changed before dispatch.");
          }
          if (!providerPresetId || store.getProviderPreset(providerPresetId)?.enabled !== true) {
            throw new HttpError(409, "native_intake_provider_unavailable", "The channel provider preset is unavailable.");
          }
        };
        assertCurrent();
        if (!task || !channel || !workspace?.ok || !providerPresetId) {
          throw new HttpError(409, "native_intake_workspace_unavailable", "The channel execution workspace is unavailable.");
        }
        const attachmentPrompt = await materializeTaskAttachmentsForPrompt({
          store, task, channel, now: new Date().toISOString(), imageVisionSummarizer,
        });
        assertCurrent();
        const runId = await start({
          workspaceCwd: store.paths.cwd, cwd: workspace.executionCwd, providerPresetId, runnerId: "pi",
          teammateId: task.assigneeTeammateId ?? channel.defaultTeammateId, requestedSkillId: task.requestedSkillId,
          task: { id: task.id, title: task.title, channelId: task.channelId, prompt: attachmentPrompt ? `${task.prompt}\n\n${attachmentPrompt}` : task.prompt },
          idempotencyKey: key, workspaceAccessMode: "read_only", tools: readOnlyRunTools.filter(tool => channel.allowedTools?.includes(tool)),
          appendSystemPrompt: ["Scope the channel task. Inspect the project and propose the next step or ask for clarification."],
        }, assertCurrent);
        this.settle(store, receipt.receiptId, runId ? { status: "admitted", runId }
          : { status: "held", reasonCode: "native_intake_run_not_admitted" });
      } catch (error) {
        signal.throwIfAborted();
        const reasonCode = error instanceof HttpError ? error.code : "native_intake_dispatch_failed";
        const status = ["native_intake_quiet_hours", "native_intake_provider_unavailable", "resume_blocked"].includes(reasonCode) ? "pending" : "held";
        this.settle(store, receipt.receiptId, { status, reasonCode });
      }
    }
  }
}

function isTaskRunForReceipt(store: RunStore, receipt: NativeWorkIntakeReceipt, runId: string): boolean {
  const run = store.getRun(runId);
  return run?.taskId === receipt.executionId && run.channelId === receipt.sourceScope;
}
