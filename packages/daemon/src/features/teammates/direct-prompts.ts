import type { AiTeammate } from "@ling-stack/core";

export function formatTeammateDirectPrompt(
  teammate: AiTeammate,
  messages: readonly { readonly authorType: string; readonly body: string; readonly status: string }[],
): string {
  const history = messages
    .filter((message) => message.status === "ready")
    .slice(-20)
    .map((message) => `${message.authorType === "ai-teammate" ? teammate.displayName : "User"}: ${message.body}`)
    .join("\n");
  return [
    `Teammate: ${teammate.displayName}`,
    `Role: ${teammate.roleKey}`,
    `Description: ${teammate.description}`,
    "",
    "Private conversation:",
    history || "No prior messages.",
    "",
    "Reply to the latest user message.",
  ].join("\n");
}
