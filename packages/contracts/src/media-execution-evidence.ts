/** Closed, versioned protocol facts. These values describe observations, not execution authority. */
export const hostMediaProtocols = [
  "image_response_v1", "seedance_task_v1", "comfy_jobs_v1", "comfy_prompt_legacy_v1",
] as const;
export type HostMediaProtocol = typeof hostMediaProtocols[number];
export const hostMediaEffectKinds = ["image_request", "comfy_image_upload", "remote_generation_submit"] as const;
export type HostMediaEffectKind = typeof hostMediaEffectKinds[number];

export function isHostMediaProtocol(value: unknown): value is HostMediaProtocol {
  return typeof value === "string" && (hostMediaProtocols as readonly string[]).includes(value);
}
export function isHostMediaEffectKind(value: unknown): value is HostMediaEffectKind {
  return typeof value === "string" && (hostMediaEffectKinds as readonly string[]).includes(value);
}

/** Decoded remote status still needs captured transport, namespace and source facts before settlement. */
export type MediaRemoteTerminalObservation =
  | { readonly protocol: "seedance_task_v1"; readonly externalOperationId: string;
      readonly identitySource: "echoed_id" | "exact_status_route";
      readonly rawStatus: "succeeded" | "failed"; readonly outcome: "completed" | "failed" }
  | { readonly protocol: "comfy_jobs_v1"; readonly externalOperationId: string;
      readonly identitySource: "echoed_id" | "exact_status_route";
      readonly rawStatus: "completed" | "failed" | "cancelled"; readonly outcome: "completed" | "failed" | "cancelled" }
  | { readonly protocol: "comfy_prompt_legacy_v1"; readonly externalOperationId: string;
      readonly identitySource: "exact_history_key";
      readonly rawStatus: "success" | "error"; readonly outcome: "completed" | "failed" };
