import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

export type ComputerUsePreviewCloseReason =
  | "user"
  | "window_close"
  | "route_change"
  | "session_switch"
  | "terminal"
  | "source_error"
  | "stall_timeout"
  | "shutdown";

export type ComputerUsePreviewTelemetryEvent =
  | { readonly name: "preview_opened"; readonly firstFrameLatencyMs: number }
  | { readonly name: "preview_hidden"; readonly reason: "user" | "stall_timeout" }
  | { readonly name: "preview_closed"; readonly reason: ComputerUsePreviewCloseReason }
  | { readonly name: "preview_source_stalled" }
  | { readonly name: "preview_recovered"; readonly recoveryLatencyMs: number }
  | { readonly name: "preview_permission_denied" }
  | { readonly name: "preview_renderer_crashed"; readonly crashCount: number }
  | { readonly name: "preview_renderer_recreated"; readonly recreationCount: number }
  | { readonly name: "preview_terminal_closed"; readonly status: "succeeded" | "failed" | "cancelled" }
  | { readonly name: "preview_stop_requested" }
  | { readonly name: "preview_stop_acknowledged"; readonly accepted: boolean }
  | { readonly name: "preview_stop_failed" };

export interface ComputerUsePreviewTelemetry {
  record(event: ComputerUsePreviewTelemetryEvent): void;
}

export const NOOP_COMPUTER_USE_PREVIEW_TELEMETRY: ComputerUsePreviewTelemetry = {
  record: () => undefined,
};

/**
 * Stores a small local JSONL stream for reliability and performance diagnosis.
 *
 * The serializer below is deliberately allowlist-only. It never accepts or
 * writes session ids, target labels, native window ids, descriptors, source
 * titles, clipboard data, frame content, or user-authored text.
 */
export class FileComputerUsePreviewTelemetry implements ComputerUsePreviewTelemetry {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes = 1_048_576,
  ) {}

  record(event: ComputerUsePreviewTelemetryEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      try {
        if (statSync(this.path).size >= this.maxBytes) {
          truncateSync(this.path, 0);
        }
      } catch {
        // The first event creates the file below.
      }
      appendFileSync(
        this.path,
        `${JSON.stringify(serializeComputerUsePreviewTelemetryEvent(event, this.now()))}\n`,
        "utf8",
      );
    } catch {
      // Telemetry is diagnostic-only and must never alter preview lifecycle.
    }
  }
}

export function serializeComputerUsePreviewTelemetryEvent(
  event: ComputerUsePreviewTelemetryEvent,
  occurredAt: Date,
): Readonly<Record<string, string | number | boolean>> {
  const base = {
    ts: occurredAt.toISOString(),
    event: event.name,
  };
  switch (event.name) {
    case "preview_opened":
      return { ...base, firstFrameLatencyMs: nonNegativeDuration(event.firstFrameLatencyMs) };
    case "preview_hidden":
    case "preview_closed":
      return { ...base, reason: event.reason };
    case "preview_recovered":
      return { ...base, recoveryLatencyMs: nonNegativeDuration(event.recoveryLatencyMs) };
    case "preview_renderer_crashed":
      return { ...base, crashCount: nonNegativeCount(event.crashCount) };
    case "preview_renderer_recreated":
      return { ...base, recreationCount: nonNegativeCount(event.recreationCount) };
    case "preview_terminal_closed":
      return { ...base, status: event.status };
    case "preview_stop_acknowledged":
      return { ...base, accepted: event.accepted };
    case "preview_source_stalled":
    case "preview_permission_denied":
    case "preview_stop_requested":
    case "preview_stop_failed":
      return base;
  }
}

function nonNegativeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
