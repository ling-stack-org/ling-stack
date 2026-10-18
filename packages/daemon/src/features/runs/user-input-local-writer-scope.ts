import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import { isTrackedConversationMediaGenerationToolHandler } from "../media/conversation-tool-handler.js";

/** Track the outer Host callback, including Broker post-result writes, not its tool result. */
export function scopeUserInputLocalWriters(request: PiRunnerRunOptions, writers: AttemptLocalWriterGroup,
  options: { readonly requireTrackedMedia?: boolean; readonly onToolBoundary?: (request: unknown) => void } = {}): PiRunnerRunOptions {
  const onEvent = request.onEvent && writers.wrapSync("runner_event", request.onEvent);
  const effect = <A extends unknown[], R>(callback: (...args: A) => R): ((...args: A) => R) => (...args) => {
    options.onToolBoundary?.(args[0]);
    return callback(...args);
  };
  return {
    ...request,
    ...(onEvent ? { onEvent: event => {
      // Diagnostics arriving after SDK drain cannot reopen the closed lifetime.
      if (!writers.getSnapshot().closed) onEvent(event);
    } } : {}),
    ...(request.onToolBefore ? { onToolBefore: effect(writers.wrapAsync("tool_before", request.onToolBefore)) } : {}),
    ...(request.onApprovalRequired ? { onApprovalRequired: effect(writers.wrapAsync("approval", request.onApprovalRequired)) } : {}),
    ...(request.onPermissionRequired ? { onPermissionRequired: effect(writers.wrapAsync("permission", request.onPermissionRequired)) } : {}),
    ...(request.onUserInputRequest ? { onUserInputRequest: writers.wrapAsync("user_input", request.onUserInputRequest) } : {}),
    ...(request.onTaskContinuationBoundary ? {
      onTaskContinuationBoundary: writers.wrapAsync("continuation_boundary", request.onTaskContinuationBoundary),
    } : {}),
    ...(request.onHostCapabilityCall ? { onHostCapabilityCall: effect(writers.wrapAsync("host_capability", request.onHostCapabilityCall)) } : {}),
    ...(request.onToolHydrationRequest ? { onToolHydrationRequest: effect(writers.wrapAsync("hydration", request.onToolHydrationRequest)) } : {}),
    ...(request.onMcpToolCall ? { onMcpToolCall: effect(writers.wrapAsync("mcp", request.onMcpToolCall)) } : {}),
    ...(request.onMediaGenerationToolCall ? {
      // The production Media handler reserves its own exact background chain
      // before its first Store write. This wrapper owns only the outer callback.
      onMediaGenerationToolCall: effect(writers.wrapAsync("media", (...args) => {
        if (options.requireTrackedMedia !== false
          && !isTrackedConversationMediaGenerationToolHandler(request.onMediaGenerationToolCall!)) {
          throw new Error("media_host_lifecycle_unsupported: an arbitrary tool callback cannot prove background completion.");
        }
        return request.onMediaGenerationToolCall!(...args);
      })),
    } : {}),
  };
}
