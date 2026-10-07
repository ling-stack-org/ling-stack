import { isDeepStrictEqual } from "node:util";
import type { EffectiveRunPolicySnapshot, RunSession, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { isNativeRestrictedCommandRuntime, type NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import { workflowOperationAuthorityRejection } from "./workflow-operation-effect-gate.js";
import { assertCommandLaunchApproval } from "./command-launch-approval.js";
import type { HostCommandOperation } from "../../runtime/host-operation-effects.js";

function requireAuthority(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

/** Captures a typed command's immutable inputs. Revalidates actual SQLite facts at every
 * asynchronous boundary and within the journal's atomic launch callback. Never a grant.
 */
export function createRestrictedCommandDispatch(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly request: PiRunnerApprovalRequest;
  readonly approvalId?: string;
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly hostOperation?: HostCommandOperation;
}) {
  const source = structuredClone(input.run), request = structuredClone(input.request);
  const fence = Object.freeze({ ...input.sourceFence });
  const context = validateWorkflowOperationRunContext({ store: input.store, run: source });
  if (context.status === "legacy") return undefined;
  requireAuthority(context.status === "ready", context.status === "blocked" ? context.code : "operation_binding_snapshot_invalid");
  const runtime = input.restrictedCommandRuntime;
  requireAuthority(isNativeRestrictedCommandRuntime(runtime), "operation_binding_isolation_unavailable");
  const snapshot = isRecord(source.requestSnapshot) ? source.requestSnapshot : {};
  const value = snapshot.effectivePolicySnapshot;
  requireAuthority(isRecord(value) && isRecord(value.toolDecisions) && Array.isArray(value.allowedWritePaths),
    "restricted_command_policy_missing");
  // The sandbox compiler validates the full shape before any process is created.
  const policy = structuredClone(value) as unknown as EffectiveRunPolicySnapshot;
  const command = isRecord(request.input) && typeof request.input.command === "string" ? request.input.command : "";
  const operations = context.ownedOperations.filter(operation => operation.kind === "run_command"
    && operation.binding?.effectScope.exactCommands.includes(command));
  requireAuthority(operations.length === 1, "operation_binding_command_out_of_scope");
  const operation = operations[0]!;
  const workspacePolicy = input.store.getApprovalPolicy();
  const check = () => {
    input.signal?.throwIfAborted();
    const read = () => {
      requireAuthority(input.store.isCurrentRunExecutionOwner(source.id, fence)
        && source.workUnitId === fence.workUnitId, "stale_run_execution");
      const current = input.store.getRun(source.id);
      requireAuthority(current?.status === "running" && request.task.id === source.taskId
        && (["cwd", "taskId", "workUnitId", "channelId", "threadId", "teammateId", "workflowStepId"] as const)
          .every(key => current[key] === source[key])
        && isDeepStrictEqual(current.requestSnapshot, source.requestSnapshot), "restricted_command_source_changed");
      const rejection = workflowOperationAuthorityRejection({ store: input.store, run: source, request, restrictedCommandRuntime: runtime });
      requireAuthority(!rejection, rejection?.code ?? "restricted_command_authority_invalid");
      const currentPolicy = input.store.getApprovalPolicy();
      requireAuthority(isDeepStrictEqual(currentPolicy, workspacePolicy)
        && currentPolicy.updatedAt === policy.workspacePolicyUpdatedAt
        && currentPolicy.toolDecisions.bash !== "deny" && policy.toolDecisions.bash !== "deny",
        "restricted_command_policy_changed");
      assertCommandLaunchApproval({ store: input.store, source, fence, request, policy,
        approvalId: input.approvalId, extraSecrets: input.extraSecrets,
        delegatedRequirementFingerprint: context.step.metadata?.delegatedRequirement?.fingerprint,
        codePrefix: "restricted_command" });
    };
    input.store.readSnapshot(read);
  };
  check();
  const protectedActorSource = runtime.captureProtectedActorSource({ store: input.store, run: source,
    sourceFence: fence, command, toolCallId: request.toolCallId });
  return {
    // The atomic Host preflight rejects stale authority before entering the
    // native producer. Preparation and native spawn retain their own checks.
    assertMayLaunch: check,
    prepare: async () => {
      // Reserve the native copy/helper producer synchronously before runtime
      // preparation can create a directory, spawn a helper or cross an await.
      const preparation = input.hostOperation?.registerPreparation("restricted-command-prepare");
      try {
        const prepared = await runtime.prepare({ command, cwd: source.cwd, inputRefs: operation.binding!.inputRefs, policy,
          source: { ...fence, workspaceId: workspacePolicy.workspaceId, runId: source.id, toolCallId: request.toolCallId },
          assertCurrentAuthority: check, signal: input.signal, hostOperation: preparation, protectedActorSource });
        return { ...prepared, finishHostPreparation: () => preparation?.finish() };
      } catch (error) {
        preparation?.finish();
        throw error;
      }
    },
  };
}
