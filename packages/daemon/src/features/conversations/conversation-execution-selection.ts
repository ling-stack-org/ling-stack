import { isExternalExecutionEngineId, type RunStore, type RunSession } from "@ling-stack/core";
import { parseExecutionBindingRequest, type ConversationStreamRequest } from "@ling-stack/contracts";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { HttpError } from "../../errors.js";

type Selection = Pick<ConversationStreamRequest, "executionBinding" | "providerPresetId">;

/** Resolve only new input; accepted replay always uses its persisted request first. */
export function resolveConversationExecutionSelection(store: RunStore, registry: RunnerRegistry, input: Selection): Selection {
  if (input.executionBinding) {
    if (input.providerPresetId) throw new HttpError(400, "execution_binding_conflict", "Choose one execution configuration.");
    return { executionBinding: parseExecutionBindingRequest(input.executionBinding) };
  }
  if (input.providerPresetId) return { providerPresetId: input.providerPresetId };
  const settings = loadWorkspaceRuntimeSettings(store, registry);
  if (settings.migration?.legacyDefaultRunnerId) {
    throw new HttpError(409, "legacy_runner_migration_required", "Migrate the workspace default to a native profile.");
  }
  const binding = settings.defaultExecutionBinding;
  if (binding) return { executionBinding: parseExecutionBindingRequest(binding) };
  throw new HttpError(409, "execution_selection_required", "Select a conversation model or a native execution profile.");
}

export function inheritConversationExecutionSelection(store: RunStore, registry: RunnerRegistry, previous: RunSession | undefined,
  providerPresetId?: string): Selection {
  const snapshot = previous?.requestSnapshot as Record<string, unknown> | undefined;
  if (snapshot?.executionBinding !== undefined) {
    const binding = parseExecutionBindingRequest(snapshot.executionBinding);
    if (binding.kind === "native_profile" && providerPresetId) throw new HttpError(409, "execution_binding_conflict", "The replacement must retain its native execution profile.");
    return { executionBinding: binding };
  }
  if (previous && (isExternalExecutionEngineId(previous.providerName) || isExternalExecutionEngineId(String(snapshot?.runnerId ?? "")))) {
    throw new HttpError(409, "legacy_runner_migration_required", "Historical endpoint runs require migration before replacement.");
  }
  return resolveConversationExecutionSelection(store, registry, { providerPresetId: providerPresetId ?? previous?.providerPresetId
    ?? (typeof snapshot?.providerPresetId === "string" ? snapshot.providerPresetId : undefined) });
}
