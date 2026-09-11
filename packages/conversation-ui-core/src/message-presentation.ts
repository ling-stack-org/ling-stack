export interface ConversationMessagePresentationInput {
  readonly content: string;
  readonly errorMessage?: string;
  readonly status?: string;
  readonly runtimeFailed?: boolean;
  readonly streaming?: boolean;
  readonly streamingPlaceholder?: string;
}

export interface ConversationMessagePresentation {
  readonly body: string;
  readonly errorText: string;
}

const FAILURE_STATUSES = new Set(["blocked", "failed"]);

/**
 * Projects the shared narrative/error boundary for every conversation surface.
 * Content remains narrative and a typed error field owns the failure
 * presentation. A blocked run can mean it is waiting for permission; status
 * alone never turns model text or a user instruction into an error.
 */
export function projectConversationMessagePresentation(
  input: ConversationMessagePresentationInput,
): ConversationMessagePresentation {
  const content = input.content;
  const failed = Boolean(input.runtimeFailed || FAILURE_STATUSES.has(input.status ?? ""));
  const errorText = input.errorMessage?.trim() ?? "";
  const showError = Boolean(errorText && failed);
  const errorOwnsBody = showError && content.trim() === errorText;
  const errorAlreadyNarrated = showError && contentContainsTypedFailure(content, errorText);
  return {
    body: errorOwnsBody
      ? ""
      : content || (input.streaming ? input.streamingPlaceholder ?? "" : ""),
    // Some daemon rows keep the user-facing blocked sentence in `content`
    // and the same reason in the typed error field. Keep the complete
    // sentence as narrative, but do not render a second inline error row.
    errorText: showError && !errorAlreadyNarrated ? errorText : "",
  };
}

function contentContainsTypedFailure(content: string, errorText: string): boolean {
  const normalizedContent = content.trim();
  const normalizedError = errorText.trim();
  if (!normalizedContent || !normalizedError || normalizedContent === normalizedError) {
    return false;
  }
  const failurePrefixes = [
    "AI teammate is blocked:",
    "AI agent is blocked:",
    "Teammate is blocked:",
    "Blocked:",
    "Error:",
  ];
  return failurePrefixes.some((prefix) =>
    normalizedContent === `${prefix} ${normalizedError}` || normalizedContent === `${prefix}${normalizedError}`,
  );
}
