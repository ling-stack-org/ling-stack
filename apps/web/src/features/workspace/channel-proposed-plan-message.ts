import type { ChannelMessage, ProposedPlanArtifact } from "../../types.js";

export interface ParsedChannelProposedPlanMessage {
  readonly displayBody: string;
  readonly plan: ProposedPlanArtifact;
}

const proposedPlanPattern = /<proposed_plan(?:\s+title=(?:"([^"]+)"|'([^']+)'))?\s*>([\s\S]*?)<\/proposed_plan>/i;

export function readChannelProposedPlanMessage(
  text: string,
  message: ChannelMessage,
): ParsedChannelProposedPlanMessage | undefined {
  const match = proposedPlanPattern.exec(text);
  if (!match) return undefined;

  const bodyMarkdown = (match[3] ?? "").trim();
  if (!bodyMarkdown) return undefined;

  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();
  const title = (match[1] ?? match[2] ?? readFirstMarkdownHeading(bodyMarkdown) ?? "Proposed plan").trim();
  return {
    displayBody: [before, after].filter(Boolean).join("\n\n"),
    plan: {
      id: `proposed_plan_${message.id}`,
      workspaceId: message.workspaceId,
      threadId: message.threadId ?? message.id,
      sourceMessageId: message.id,
      sourceRunId: message.linkedRunId,
      title,
      bodyMarkdown,
      status: "draft",
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  };
}

function readFirstMarkdownHeading(markdown: string): string | undefined {
  return markdown
    .split(/\n/u)
    .map((line) => /^#{1,3}\s+(.+)$/.exec(line.trim())?.[1]?.trim())
    .find(Boolean);
}
