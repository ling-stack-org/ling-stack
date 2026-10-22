import { isExternalExecutionEngineId, type ConversationExecutionSelectionResponse } from "@ling-stack/contracts";
import type { ConversationHomeModelOption, ConversationHomeMessage, ConversationHomeDetailContext } from "./normal-conversation-types.js";

/** Editing belongs to the source Run, independently of the model chosen for the next message. */
export function resolveConversationReplacementProvider(message: Pick<ConversationHomeMessage, "runId" | "turnId">,
  context: Pick<ConversationHomeDetailContext, "runs" | "runLinks"> | undefined, selectedPreset?: string): string | undefined {
  const runId = message.runId ?? context?.runLinks.find(link => link.turnId === message.turnId)?.runId;
  const run = context?.runs.find(item => item.id === runId);
  if (!run) return undefined;
  const snapshot = run.requestSnapshot as { executionBinding?: { kind?: string } } | undefined;
  return snapshot?.executionBinding?.kind === "native_profile" || isExternalExecutionEngineId(run.providerName)
    ? undefined : selectedPreset;
}

/** A failed/unknown read cannot silently select the Pi default. Explicit choices retain their owner. */
export function projectNativeConversationSelection(selection: ConversationExecutionSelectionResponse | undefined,
  error: boolean, blockedLabel: string): { readonly option?: ConversationHomeModelOption; readonly defaultId?: string; readonly pending: boolean } {
  if (!selection) return { pending: !error, ...(error ? { defaultId: "native-selection-unavailable", option: {
    id: "native-selection-unavailable", displayName: blockedLabel, model: "", enabled: true, runnable: false, blocker: blockedLabel,
  } } : {}) };
  if (selection.status === "not_selected") return { pending: false };
  const binding = selection.executionBinding;
  const id = binding?.kind === "native_profile" ? `native:${binding.engineId}:${binding.profileId}:${binding.profileRevision}:${binding.nativeModelId ?? ""}` : "native-migration-required";
  const names: Readonly<Record<string, string>> = { "codex-app-server": "Codex", "kimi-acp": "Kimi Code CLI", "openclaw-acp": "OpenClaw" };
  const native = binding?.kind === "native_profile" ? binding : undefined;
  return { pending: false, defaultId: id, option: { id,
    displayName: names[native?.engineId ?? selection.defaultRunnerId] ?? "Execution engine",
    model: native?.nativeModelId ?? "", executionBinding: native,
    enabled: true, runnable: selection.status === "ready" && Boolean(native),
    blocker: selection.status === "ready" ? undefined : blockedLabel } };
}
