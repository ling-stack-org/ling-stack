import {
  MessageBubble as SharedMessageBubble,
  type MessageBubbleProps as SharedMessageBubbleProps,
  type MessageBubbleTone,
} from "@ling-stack/conversation-ui-react";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type { MessageBubbleTone };

export type MessageBubbleProps = SharedMessageBubbleProps;

export function MessageBubble({
  body,
  bodyCompact = true,
  bodyCwd,
  bodyNode,
  pending = false,
  ...props
}: MessageBubbleProps): JSX.Element {
  const resolvedBodyNode = bodyNode ?? (body ? (
    <MessageBodyRenderer
      text={body}
      cwd={bodyCwd}
      compact={bodyCompact}
      streaming={pending}
    />
  ) : null);

  return (
    <SharedMessageBubble
      {...props}
      bodyCompact={bodyCompact}
      bodyCwd={bodyCwd}
      bodyNode={resolvedBodyNode}
      pending={pending}
    />
  );
}
