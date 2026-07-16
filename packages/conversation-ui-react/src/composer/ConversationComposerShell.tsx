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
  readonly onDragOver?: DragEventHandler<HTMLDivElement>;
  readonly onDragLeave?: DragEventHandler<HTMLDivElement>;
  readonly onDrop?: DragEventHandler<HTMLDivElement>;
}

export function ConversationComposerShell({
  ariaLabel,
  approvalNode,
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
}: ConversationComposerShellProps): JSX.Element {
  const rootClassName = [
    "conversation-composer",
    "composer-panel",
    `conversation-composer-surface-${surface}`,
    `conversation-composer-density-${density}`,
    className,
  ].filter(Boolean).join(" ");
  const zoneClassName = [
    "conversation-composer-input-zone",
    "composer-drop-zone",
    dropZoneClassName,
  ].filter(Boolean).join(" ");
  const toolbarClassNames = [
    "conversation-composer-toolbar",
    "composer-primary-actions",
    toolbarClassName,
  ].filter(Boolean).join(" ");
  const leftClassNames = [
    "conversation-composer-left-tools",
    "composer-tool-row",
    leftToolsClassName,
  ].filter(Boolean).join(" ");
  const rightClassNames = [
    "conversation-composer-right-tools",
    rightToolsClassName,
  ].filter(Boolean).join(" ");

  return (
    <section
      ref={rootRef}
      className={rootClassName}
      style={style}
      aria-label={ariaLabel}
      data-surface={surface}
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
  );
}
