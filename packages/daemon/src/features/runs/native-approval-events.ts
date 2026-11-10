import type { RunEventEnvelope, RunStore } from "@ling-stack/core";

export function isNativeApprovalEvent(store: RunStore, envelope: RunEventEnvelope): boolean {
  if (!envelope.type.startsWith("approval_")) return false;
  const id = (envelope.data as { readonly approvalId?: unknown }).approvalId;
  return typeof id === "string" && Boolean(store.getNativeApprovalCorrelation?.(id));
}
