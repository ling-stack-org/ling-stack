import type { ComputerUsePreviewProjection } from "@ling-stack/contracts";
import { isTerminalComputerUseStatus } from "@ling-stack/contracts";
import type { ComputerUsePipRendererSnapshot } from "../../shared/desktop-capabilities.js";

export function selectComputerUsePresentation(input: {
  readonly selectedConversationId?: string;
  readonly projections: readonly ComputerUsePreviewProjection[];
}): ComputerUsePreviewProjection | undefined {
  if (!input.selectedConversationId) {
    return undefined;
  }
  return input.projections
    .filter((projection) => projection.conversationId === input.selectedConversationId)
    .filter((projection) => !isTerminalComputerUseStatus(projection.status))
    .sort(compareLatestComputerUseProjection)[0];
}

export function compareLatestComputerUseProjection(
  left: ComputerUsePreviewProjection,
  right: ComputerUsePreviewProjection,
): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.sessionId.localeCompare(left.sessionId);
}

export function terminalLingerMilliseconds(status: ComputerUsePreviewProjection["status"]): number | undefined {
  if (status === "succeeded") {
    return 1_500;
  }
  if (status === "cancelled") {
    return 300;
  }
  if (status === "failed") {
    return 5_000;
  }
  return undefined;
}

export function isSessionSuppressed(
  suppressions: Readonly<Record<string, string>>,
  sessionId: string,
  now: Date,
): boolean {
  const expiresAt = suppressions[sessionId];
  return typeof expiresAt === "string" && Date.parse(expiresAt) > now.getTime();
}

export type ComputerUsePipActivationBlockReason =
  | "session_hidden"
  | "stall_timeout"
  | "renderer_crash"
  | "auto_show_disabled";

export interface ComputerUsePipPresentationDecision {
  readonly visibilityIntent: ComputerUsePipRendererSnapshot["visibilityIntent"];
  readonly sourceActivationAllowed: boolean;
  readonly shouldRevealOrRetainWindow: boolean;
  readonly blockReason?: ComputerUsePipActivationBlockReason;
}

export function selectComputerUsePipPresentation(input: {
  readonly sessionSuppressed: boolean;
  readonly explicitlyShown: boolean;
  readonly previewAutoShow: boolean;
  readonly windowVisible: boolean;
  readonly stallTimeoutBlocked: boolean;
  readonly rendererCrashBlocked: boolean;
  readonly sourceStatus: ComputerUsePipRendererSnapshot["sourceStatus"];
  readonly frameReady: boolean;
}): ComputerUsePipPresentationDecision {
  const visibilityIntent = input.sessionSuppressed
    ? "hidden"
    : input.explicitlyShown
      ? "shown"
      : "auto";
  const blockReason = input.sessionSuppressed
    ? "session_hidden"
    : input.stallTimeoutBlocked
      ? "stall_timeout"
      : input.rendererCrashBlocked
        ? "renderer_crash"
        : !input.explicitlyShown && !input.previewAutoShow && !input.windowVisible
          ? "auto_show_disabled"
          : undefined;
  const sourceActivationAllowed = blockReason === undefined;
  const sourceSurfaceReady = (input.sourceStatus === "live" && input.frameReady)
    || input.sourceStatus === "permission_denied"
    || input.sourceStatus === "failed"
    || (input.windowVisible && (
      input.sourceStatus === "connecting"
      || input.sourceStatus === "stalled"
    ));
  return {
    visibilityIntent,
    sourceActivationAllowed,
    shouldRevealOrRetainWindow: sourceActivationAllowed && (input.windowVisible || sourceSurfaceReady),
    ...(blockReason ? { blockReason } : {}),
  };
}
