import type { CSSProperties, ReactNode, Ref } from "react";

export interface ConversationShellProps {
  readonly className?: string;
  readonly rootRef?: Ref<HTMLElement>;
  readonly style?: CSSProperties;
  readonly ariaLabel: string;
  readonly headerNode?: ReactNode;
  readonly feedNode: ReactNode;
  readonly statusNode?: ReactNode;
  readonly composerNode: ReactNode;
  readonly sideNode?: ReactNode;
}

export function ConversationShell({
  className,
  rootRef,
  style,
  ariaLabel,
  headerNode,
  feedNode,
  statusNode,
  composerNode,
  sideNode,
}: ConversationShellProps): JSX.Element {
  const rootClassName = ["conversation-shell", className].filter(Boolean).join(" ");

  return (
    <section ref={rootRef} className={rootClassName} style={style} aria-label={ariaLabel}>
      {headerNode}
      {feedNode}
      {statusNode}
      {composerNode}
      {sideNode}
    </section>
  );
}
