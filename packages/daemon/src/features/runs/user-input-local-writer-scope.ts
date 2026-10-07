import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import { isTrackedConversationMediaGenerationToolHandler } from "../media/conversation-tool-handler.js";

/** Track the outer Host callback, including Broker post-result writes, not its tool result. */
export function scopeUserInputLocalWriters(request: PiRunnerRunOptions, writers: AttemptLocalWriterGroup): PiRunnerRunOptions {
  return {
    ...request,
    ...(request.onEvent ? { onEvent: writers.wrapSync("runner_event", request.onEvent) } : {}),
    ...(request.onToolBefore ? { onToolBefore: writers.wrapAsync("tool_before", request.onToolBefore) } : {}),
    ...(request.onApprovalRequired ? { onApprovalRequired: writers.wrapAsync("approval", request.onApprovalRequired) } : {}),
    ...(request.onPermissionRequired ? { onPermissionRequired: writers.wrapAsync("permission", request.onPermissionRequired) } : {}),
    ...(request.onUserInputRequest ? { onUserInputRequest: writers.wrapAsync("user_input", request.onUserInputRequest) } : {}),
    ...(request.onTaskContinuationBoundary ? {
      onTaskContinuationBoundary: writers.wrapAsync("continuation_boundary", request.onTaskContinuationBoundary),
    } : {}),
    ...(request.onHostCapabilityCall ? { onHostCapabilityCall: writers.wrapAsync("host_capability", request.onHostCapabilityCall) } : {}),
    ...(request.onToolHydrationRequest ? { onToolHydrationRequest: writers.wrapAsync("hydration", request.onToolHydrationRequest) } : {}),
    ...(request.onMcpToolCall ? { onMcpToolCall: writers.wrapAsync("mcp", request.onMcpToolCall) } : {}),
    ...(request.onMediaGenerationToolCall ? {
      // The production Media handler reserves its own exact background chain
      // before its first Store write. This wrapper owns only the outer callback.
      onMediaGenerationToolCall: writers.wrapAsync("media", (...args) => {
        if (!isTrackedConversationMediaGenerationToolHandler(request.onMediaGenerationToolCall!)) {
          throw new Error("media_host_lifecycle_unsupported: an arbitrary tool callback cannot prove background completion.");
        }
        return request.onMediaGenerationToolCall!(...args);
      }),
    } : {}),
  };
}
