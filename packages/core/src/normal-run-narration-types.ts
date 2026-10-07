import type { ConversationItemV1, ControlPlaneEvent } from "@ling-stack/contracts";

export type PublishNormalRunNarrationResult =
  | { readonly ok: true; readonly item: ConversationItemV1; readonly event: ControlPlaneEvent; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: "unsupported_surface" | "run_not_terminal" | "source_item_conflict"
    | "stale_run" | "narration_source_conflict" | "narration_empty" | "narration_incomplete"
    | "narration_budget_exceeded" | "publication_conflict" };
