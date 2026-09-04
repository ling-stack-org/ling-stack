import { Loader2 } from "lucide-react";
import {
  MessageRow as SharedMessageRow,
  type MessageRowAuthorType,
  type MessageRowProps as SharedMessageRowProps,
  type MessageRowTone,
} from "@ling-stack/conversation-ui-react";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export type { MessageRowAuthorType, MessageRowTone };

export type MessageRowProps = SharedMessageRowProps;

export function MessageRow({
  body,
  bodyCwd,
  bodyCompact,
  bodyStreaming = false,
  bodyOnOpenLocalFile,
  bodyNode,
  ...props
}: MessageRowProps): React.JSX.Element {
  const generatedBodyNode = body ? (
    <MessageBodyRenderer
      text={body}
      cwd={bodyCwd}
      compact={bodyCompact}
      streaming={bodyStreaming}
      onOpenLocalFile={bodyOnOpenLocalFile}
    />
  ) : null;
  const resolvedBodyNode = bodyNode && !bodyStreaming ? bodyNode : (bodyNode ?? generatedBodyNode) ? (
    <div className={bodyStreaming ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
      {bodyStreaming ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
      {bodyNode ?? generatedBodyNode}
    </div>
  ) : null;

  return (
    <SharedMessageRow
      {...props}
      bodyStreaming={bodyStreaming}
      bodyNode={resolvedBodyNode}
    />
  );
}
