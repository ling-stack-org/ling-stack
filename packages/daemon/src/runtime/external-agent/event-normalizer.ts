import { redactSecrets } from "@ling-stack/core";
import type { PiRunnerEvent } from "@ling-stack/runner-pi";

export interface ExternalAgentEvent {
  readonly type: string;
  readonly data?: unknown;
}

export function normalizeExternalAgentEvent(event: ExternalAgentEvent, extraSecrets: readonly (string | undefined)[] = []): PiRunnerEvent | undefined {
  if (event.type === "text_delta") {
    const data = event.data as { readonly text?: unknown } | undefined;
    return typeof data?.text === "string" ? { type: "assistant_text_delta", text: String(redactSecrets(data.text, extraSecrets)) } : undefined;
  }
  if (event.type === "run_error") {
    const data = event.data as { readonly message?: unknown; readonly taskId?: unknown } | undefined;
    return {
      type: "run_error",
      taskId: typeof data?.taskId === "string" ? data.taskId : "external-agent",
      message: String(redactSecrets(typeof data?.message === "string" ? data.message : "External runner failed.", extraSecrets)),
    };
  }
  return undefined;
}
