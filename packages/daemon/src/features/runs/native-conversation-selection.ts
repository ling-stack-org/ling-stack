import { applyConversationModeToEffectiveRunPolicySnapshot, resolveSessionRunPolicy, type RunStore } from "@ling-stack/core";
import type { ConversationExecutionSelectionQuery, ConversationExecutionSelectionResponse } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { resolveNativeRunnerSelection } from "../../runtime/native-runners.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { NativeBoundRunRequest, NativeRunTargetDispatcher } from "./native-run-dispatcher.js";

/** Inspection shares the target admission port; it creates no Thread, Turn, Run or native submission. */
export async function inspectNativeConversationSelection(store: RunStore, registry: RunnerRegistry,
  target: NativeRunTargetDispatcher, query: ConversationExecutionSelectionQuery): Promise<ConversationExecutionSelectionResponse> {
  const cwd = store.paths.cwd;
  const settings = loadWorkspaceRuntimeSettings(store, registry);
  const binding = settings.defaultExecutionBinding;
  const base = { cwd, defaultRunnerId: settings.defaultRunnerId, executionBinding: binding };
  if (settings.migration?.legacyDefaultRunnerId) return { ...base, status: "blocked", reason: "legacy_runner_migration_required" };
  if (binding?.kind !== "native_profile") return { ...base, status: "not_selected" };
  try {
    // Inspection accepts a permission selection, never a confirmation or an execution capability.
    // The actual send still passes the normal parser and its full-access confirmation gate.
    const request: NativeBoundRunRequest = { ...query, cwd: query.projectPath || cwd, workspaceCwd: cwd,
      executionBinding: binding, task: { id: "native-conversation-inspection", title: "Conversation", prompt: "Inspect availability only" } };
    const policy = () => {
      const thread = query.threadId ? store.getLingThread(query.threadId) : undefined;
      if (query.threadId && (!thread || thread.kind !== "conversation" || thread.status === "archived")) {
        throw new HttpError(409, "conversation_unavailable", "The conversation is unavailable.");
      }
      const resolved = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), ...query, channelBoundPath: request.cwd });
      return { approvalPolicy: resolved.approvalPolicy,
        effectivePolicySnapshot: applyConversationModeToEffectiveRunPolicySnapshot(resolved.snapshot, thread?.conversationMode.mode ?? "default") };
    };
    resolveNativeRunnerSelection(registry, request, settings.allowedRunnerIds, Boolean(target.assertAvailable));
    if (!target.assertAvailable) throw new HttpError(409, "native_execution_unavailable", "Execution verification is unavailable.");
    const resolved = policy();
    const assertCurrentAuthority = () => {
      if (JSON.stringify(loadWorkspaceRuntimeSettings(store, registry)) !== JSON.stringify(settings)
        || JSON.stringify(policy()) !== JSON.stringify(resolved)) throw new HttpError(409, "native_policy_changed", "Conversation permissions changed.");
    };
    await target.assertAvailable({ runRequest: request, store, ...resolved, workflowSurface: "normal_conversation",
      signal: AbortSignal.timeout(15_000), assertCurrentAuthority });
    assertCurrentAuthority();
    return { ...base, status: "ready" };
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "native_execution_unavailable";
    return { ...base, status: "blocked", reason };
  }
}
