import { useEffect, useId, useRef, useState } from "react";
import type { ConversationTimelineReasoningItem } from "@ling-stack/conversation-ui-core";
import { conversationTimelineRendererKey } from "@ling-stack/conversation-ui-core";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { useI18n } from "../../../i18n.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export function ConversationTimelineReasoningRenderer({ item, cwd, depth }: {
  readonly item: ConversationTimelineReasoningItem;
  readonly cwd?: string;
  readonly depth: 0 | 1;
}): React.JSX.Element {
  const { t } = useI18n();
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const disclosure = useConversationBlockView({
    blockId: `timeline-item:${item.id}`, revisionKey: String(item.revision),
    defaultExpanded: false, preserveTouchedStateOnRevision: true,
  });
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = (): void => {
      const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
      setOverflows(Number.isFinite(lineHeight) && content.getBoundingClientRect().height > lineHeight * 3 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [item.id, item.summary]);
  const collapsed = overflows && !disclosure.expanded;
  return (
    <section
      className="conversation-timeline-reasoning"
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey(item.kind)}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-depth={depth}
    >
      <div id={bodyId} className={`conversation-timeline-reasoning-body${collapsed ? " collapsed" : ""}`}
        role={collapsed ? "note" : undefined} aria-label={collapsed ? item.summary : undefined}>
        <div ref={contentRef} inert={collapsed}>
          <MessageBodyRenderer text={item.summary} cwd={cwd} compact streaming={false} />
        </div>
      </div>
      {overflows ? <button type="button" className="conversation-reasoning-toggle"
        aria-controls={bodyId} aria-expanded={disclosure.expanded}
        onClick={() => disclosure.setExpanded(!disclosure.expanded)}>
        {disclosure.expanded ? t("Collapse summary") : t("Expand summary")}
      </button> : null}
    </section>
  );
}
