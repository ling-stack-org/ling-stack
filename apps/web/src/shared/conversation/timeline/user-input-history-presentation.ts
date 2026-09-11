import type { ConversationTimelineUserInputItem } from "@ling-stack/conversation-ui-core";

/** State/copy are derived only from public hydration; no clock or model-text heuristics. */
export function userInputHistoryPresentation(item: ConversationTimelineUserInputItem): {
  readonly state: string;
  readonly labelKey: string;
  readonly tone: "neutral" | "danger";
  readonly copyText?: string;
} {
  const value = item.userInput;
  if (value.availability === "unavailable") return {
    state: "unavailable", labelKey: "user_input.unavailable", tone: "neutral",
  };
  if (value.kind === "user_input_request") return {
    state: value.status, labelKey: "user_input.request." + (value.status === "pending" && value.waitMode === "optional" ? "optional" : value.status),
    tone: "neutral",
    copyText: value.questions.map(q => [q.prompt, ...q.options.map(o => "- " + o.label)].join("\n\n")).join("\n\n"),
  };
  return { state: value.delivery.status, labelKey: "user_input.delivery." + value.delivery.status,
    tone: value.delivery.status === "failed" ? "danger" : "neutral",
    copyText: value.answers.map(a => a.kind === "text" ? a.text : a.label).join("\n\n") };
}
