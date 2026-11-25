import { conversationVisualizationMarkdown, normalizeConversationVisualization } from "@ling-stack/contracts";
import type { RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { PiRunnerToolHandledResult } from "@ling-stack/runner-pi";

type VisualizationWriter = Pick<RunStore, "saveConversationVisualization">;

export function publishConversationVisualization(store: VisualizationWriter,
  runId: string, fence: RuntimeAttemptFenceV1, callId: string, input: unknown, now: string): PiRunnerToolHandledResult {
  const document = normalizeConversationVisualization(input);
  if (!document) return failure("visualization_invalid", "Provide a title, a summary, and self-contained HTML within the visualization limits.");
  try {
    const result = store.saveConversationVisualization({ runId, fence, toolCallId: callId, document, now });
    if (!result.ok) {
      const messages = {
        visualization_invalid: "The visualization input is invalid.",
        visualization_owner_changed: "The run no longer owns the assistant reply.",
        visualization_conflict: "The tool call already published a different visualization.",
        visualization_limit: "This reply has reached its visualization limit.",
      };
      return failure(result.code, messages[result.code]);
    }
    const markdown = conversationVisualizationMarkdown({ artifactId: result.artifactId, label: document.title });
    return { content: [{ type: "text", text: markdown }], details: { artifactId: result.artifactId } };
  } catch {
    return failure("visualization_storage_error", "The visualization could not be saved. Continue with a text explanation if the problem persists.");
  }
}

function failure(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { code } };
}
