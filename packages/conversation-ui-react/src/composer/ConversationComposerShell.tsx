import type { CSSProperties, DragEventHandler, ReactNode, Ref } from "react";

export type ConversationComposerSurface = "channel" | "normal_conversation" | "teammate_direct";

export type ConversationComposerDensity = "floating" | "docked";

export interface ConversationComposerShellProps {
  readonly surface: ConversationComposerSurface;
  readonly density?: ConversationComposerDensity;
  readonly className?: string;
  readonly rootRef?: Ref<HTMLElement>;
  readonly ariaLabel: string;
  readonly style?: CSSProperties;
  readonly toolbarClassName?: string;
  readonly leftToolsClassName?: string;
  readonly leftToolsAriaLabel?: string;
  readonly rightToolsClassName?: string;
  readonly dropZoneClassName?: string;
  readonly dropZoneStyle?: CSSProperties;
  readonly statusNode?: ReactNode;
  readonly approvalNode?: ReactNode;
  readonly guidanceNode?: ReactNode;
  readonly previewNode?: ReactNode;
  readonly resizeHandleNode?: ReactNode;
  readonly inputNode: ReactNode;
  readonly mentionPickerNode?: ReactNode;
  readonly slashPickerNode?: ReactNode;
  readonly dropHintNode?: ReactNode;
  readonly leftToolsNode?: ReactNode;
  readonly rightToolsNode?: ReactNode;
  readonly feedbackNode?: ReactNode;
  /** Rendered outside the composer box, centered beneath it. */
  readonly bottomStatusNode?: ReactNode;
  readonly onDragOver?: DragEventHandler<HTMLDivElement>;
  readonly onDragLeave?: DragEventHandler<HTMLDivElement>;
  readonly onDrop?: DragEventHandler<HTMLDivElement>;
}

export function ConversationComposerShell({
  ariaLabel,
  approvalNode,
  bottomStatusNode,
  className,
  density = "docked",
  dropHintNode,
  dropZoneClassName,
  dropZoneStyle,
  feedbackNode,
  guidanceNode,
  inputNode,
  leftToolsAriaLabel,
  leftToolsClassName,
  leftToolsNode,
  mentionPickerNode,
  onDragLeave,
  onDragOver,
  onDrop,
  previewNode,
  resizeHandleNode,
  rightToolsClassName,
  rightToolsNode,
  rootRef,
  slashPickerNode,
  statusNode,
  style,
  surface,
  toolbarClassName,
}: ConversationComposerShellProps): React.JSX.Element {
  const rootClassName = [
    "conversation-composer",
    `conversation-composer-surface-${surface}`,
    `conversation-composer-density-${density}`,
    className,
  ].filter(Boolean).join(" ");
  const zoneClassName = [
    "conversation-composer-input-zone",
    dropZoneClassName,
  ].filter(Boolean).join(" ");
  const toolbarClassNames = [
    "conversation-composer-toolbar",
    toolbarClassName,
  ].filter(Boolean).join(" ");
  const leftClassNames = [
    "conversation-composer-left-tools",
    leftToolsClassName,
  ].filter(Boolean).join(" ");
  const rightClassNames = [
    "conversation-composer-right-tools",
    rightToolsClassName,
  ].filter(Boolean).join(" ");

  return (
    <div className="conversation-composer-frame" data-conversation-composer-frame={surface}>
      <section
        ref={rootRef}
        className={rootClassName}
        style={style}
        aria-label={ariaLabel}
        data-conversation-composer="true"
        data-surface={surface}
        data-density={density}
        {...(surface === "teammate_direct"
          ? { "data-computer-use-obstacle": "true", "data-computer-use-obstacle-kind": "composer" }
          : {})}
      >
        {statusNode}
        {approvalNode}
        {guidanceNode}
        <div
          className={zoneClassName}
          style={dropZoneStyle}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {resizeHandleNode}
          {previewNode}
          {inputNode}
          {mentionPickerNode}
          {slashPickerNode}
          {dropHintNode}
        </div>
        <div className={toolbarClassNames}>
          <div className={leftClassNames} aria-label={leftToolsAriaLabel}>
            {leftToolsNode}
          </div>
          <div className={rightClassNames}>
            {rightToolsNode}
          </div>
        </div>
        {feedbackNode}
      </section>
      {bottomStatusNode}
    </div>
  );
}
