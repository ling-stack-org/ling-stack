import { isRecord, stripTrailingSlashes } from "../utils.js";
import type { MediaRemoteTerminalObservation } from "@ling-stack/contracts";

/** Decoded protocol facts only. Host transport and Core lineage still decide settlement. */
export type SeedanceTerminalObservation = Extract<MediaRemoteTerminalObservation,
  { readonly protocol: "seedance_task_v1" }>;

export type SeedanceTaskStatusObservation =
  | { readonly status: "pending"; readonly rawStatus: "queued" | "running" }
  | { readonly status: "succeeded"; readonly videoUrl?: string; readonly terminal: SeedanceTerminalObservation }
  | { readonly status: "failed"; readonly terminal: SeedanceTerminalObservation }
  | { readonly status: "unknown"; readonly reason: string };

/**
 * Decode one response to GET /contents/generations/tasks/{externalOperationId}.
 * Only the direct task record (or a single `data` envelope) is authoritative.
 * Recursive output/status scans must not combine facts from different tasks.
 * A missing echoed ID is distinguished from an echoed ID, not fabricated.
 */
export function decodeSeedanceTaskStatusResponse(
  value: unknown,
  externalOperationId: string,
): SeedanceTaskStatusObservation {
  if (!isRecord(value)) {
    return unknown("Seedance task status response did not include a task record.");
  }
  const data = value.data;
  const envelope = isRecord(data) ? data : undefined;
  const rootStatus = value.status;
  const envelopeStatus = envelope?.status;
  if (rootStatus !== undefined && envelopeStatus !== undefined) {
    return unknown("Seedance task status response included multiple task records.");
  }
  const task = rootStatus !== undefined ? value : envelope ?? value;
  const rootId = value.id;
  const envelopeId = envelope?.id;
  for (const id of [rootId, envelopeId]) {
    if (id !== undefined && (typeof id !== "string" || id !== externalOperationId)) {
      return unknown("Seedance task status response task identity did not match the requested task id.");
    }
  }
  const identitySource = rootId !== undefined || envelopeId !== undefined
    ? "echoed_id" as const
    : "exact_status_route" as const;
  const status = task.status;
  if (status === "queued" || status === "running") {
    return { status: "pending", rawStatus: status };
  }
  if (status !== "succeeded" && status !== "failed") {
    return unknown("Seedance task status response did not include a recognizable explicit terminal or pending status.");
  }
  const terminal: SeedanceTerminalObservation = Object.freeze({
    protocol: "seedance_task_v1",
    externalOperationId,
    identitySource,
    rawStatus: status,
    outcome: status === "succeeded" ? "completed" : "failed",
  });
  if (status === "failed") {
    return { status: "failed", terminal };
  }
  const content = task.content;
  const videoUrl = isRecord(content) ? content.video_url : undefined;
  // The remote task terminal state and the availability of a usable output are
  // separate facts. A missing output must not erase an observed remote terminal.
  return {
    status: "succeeded",
    ...(typeof videoUrl === "string" && videoUrl.trim() ? { videoUrl: videoUrl.trim() } : {}),
    terminal,
  };
}

/** Build an exact task route without permitting a persisted handle to switch namespaces. */
export function createSeedanceStatusEndpoint(baseUrl: string | undefined, externalOperationId: string): string | undefined {
  if (!baseUrl || !externalOperationId || externalOperationId !== externalOperationId.trim()) {
    return undefined;
  }
  try {
    const base = new URL(baseUrl);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) {
      return undefined;
    }
    return `${stripTrailingSlashes(baseUrl)}/contents/generations/tasks/${encodeURIComponent(externalOperationId)}`;
  } catch {
    return undefined;
  }
}

function unknown(reason: string): SeedanceTaskStatusObservation {
  return { status: "unknown", reason };
}
