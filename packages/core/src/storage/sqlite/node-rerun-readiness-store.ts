import { createNodeRerunHostAdmissionPlanV1, parseNodeRerunIntent,
  type NodeRerunTargetReadinessBlockerCode, type NodeRerunTargetReadinessV1 } from "@ling-stack/contracts";
import type { ReadNodeRerunTargetReadinessInput } from "../../node-rerun-store-types.js";
import type { RunStore } from "../../run-types.js";
import type { HostRunCapacityWorkspaceIdentitySnapshot } from "../../host-run-capacity-workspace-identity.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCanonicalTimestamp, nodeRerunApprovalChannel, readNodeRerunApprovalBasis } from "./node-rerun-approval-authority.js";
import { hasNeverStartedNodeRerunTarget } from "./node-rerun-prestart.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { readReboundNodeRerunExecution, rerunRecord } from "./node-rerun-target-input.js";
import { readNodeRerunCapacityAuthority, readNodeRerunCapacityExclusion } from "./node-rerun-capacity-authority.js";

type Ports = Pick<RunStore, "getNodeRerunIntent" | "getNodeRerunTarget" | "getApprovalRequest" | "getRun"
  | "getTask" | "getWorkUnit" | "getWorkUnitAttempt" | "getRuntimeConcurrencyPolicy" | "listRuntimeEvents">;

/** Revalidates current execution prerequisites without consuming consent, capacity or resources. */
export class SqliteNodeRerunReadinessStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  readNodeRerunTargetReadiness(input: ReadNodeRerunTargetReadinessInput): NodeRerunTargetReadinessV1 | undefined {
    return this.readReadiness(input);
  }

  /** Internal capacity preparation derives its own exclusion; public readiness accepts none. */
  readNodeRerunTargetCapacityReadiness(input: ReadNodeRerunTargetReadinessInput,
    identity: HostRunCapacityWorkspaceIdentitySnapshot): NodeRerunTargetReadinessV1 | undefined {
    return this.readReadiness(input, identity);
  }

  private readReadiness(input: ReadNodeRerunTargetReadinessInput,
    identity?: HostRunCapacityWorkspaceIdentitySnapshot): NodeRerunTargetReadinessV1 | undefined {
    if (!isCanonicalTimestamp(input.now)) throw new TypeError("node_rerun_readiness.invalid_timestamp");
    return readSqliteSnapshot(this.context.database, () => {
      const target = this.ports.getNodeRerunTarget(input.recordId);
      if (!target) return undefined;
      if (input.now < target.preparedAt) throw new TypeError("node_rerun_readiness.invalid_timestamp");
      const blockers: NodeRerunTargetReadinessBlockerCode[] = [];
      const result = (): NodeRerunTargetReadinessV1 => ({ schemaVersion: 1, kind: "node_rerun_target_readiness", target,
        observedAt: input.now, decision: blockers.length ? "blocked" : "eligible_for_resource_admission", blockers,
        revalidateBeforeDispatch: true, executionAuthorized: false });
      const row = this.context.database.prepare("SELECT released_at,basis_sha256 FROM node_rerun_targets WHERE intent_id=?").get(input.recordId);
      if (row?.released_at !== null) { blockers.push("target_released"); return result(); }
      const authority = identity && readNodeRerunCapacityAuthority(this.context, this.ports, input.recordId);
      const capacity = authority && identity ? readNodeRerunCapacityExclusion(this.context, authority, identity, input.now) : undefined;
      if ((identity && (!authority || target.workspaceId !== identity.workspaceId)) || capacity === false
        || !hasNeverStartedNodeRerunTarget(this.context, this.ports, target, undefined, typeof capacity === "string" ? capacity : undefined))
        blockers.push("target_not_pristine");
      const runtime = this.ports.getRuntimeConcurrencyPolicy(target.workspaceId);
      if (!runtime || runtime.runtimeInstanceId !== target.fence.runtimeInstanceId) blockers.push("runtime_changed");
      if (readSqliteWithinTransaction(this.context.database, () => input.observeLocalExecution(structuredClone(target))) !== "absent")
        blockers.push("local_execution_unconfirmed");
      const record = this.ports.getNodeRerunIntent(input.recordId);
      const approval = this.ports.getApprovalRequest(target.approvalId);
      const basis = approval && record && nodeRerunApprovalChannel(this.context.database, record)
        ? readNodeRerunApprovalBasis(this.context.database, approval, id => this.ports.getNodeRerunIntent(id)) : undefined;
      if (!record || !basis || !approval || approval.status !== "approved" || approval.resolvedBy !== "local-user"
        || approval.decisionKind !== "approve_once" || approval.decisionRuleId !== undefined
        || !approval.resolvedAt || !isCanonicalTimestamp(approval.resolvedAt) || approval.resolvedAt < basis.createdAt
        || approval.resolvedAt > input.now || basis.expiresAt <= input.now || basis.generationId !== target.generationId
        || basis.fingerprint !== row?.basis_sha256) {
        blockers.push("approval_not_current");
      }
      if (!record) return result();
      const observation = readSqliteWithinTransaction(this.context.database, () => input.revalidate(parseNodeRerunIntent(record.intent)));
      if (!observation.observed || observation.admission.decision !== "eligible_for_host_admission") blockers.push("source_not_current");
      else {
        const plan = createNodeRerunHostAdmissionPlanV1({ intent: record.intent, ...observation, observed: observation.observed });
        if (plan.planFingerprint !== record.planFingerprint || plan.currentPolicyFingerprint !== record.policyFingerprint)
          blockers.push("source_plan_changed");
      }
      const source = this.ports.getRun(record.intent.source.runId), run = this.ports.getRun(target.runId);
      const request = run && rerunRecord(run.requestSnapshot) ? run.requestSnapshot : undefined;
      if (!source || !run || !request || !readReboundNodeRerunExecution(source, target.taskId, request.runnerExecutionInput)
        || readSqliteWithinTransaction(this.context.database, () => input.validateExecution(structuredClone(run))) !== true)
        blockers.push("frozen_execution_unavailable");
      return result();
    });
  }
}
