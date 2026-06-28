import type { ReactNode } from "react";

export interface ConversationShellProps {
  readonly className?: string;
  readonly ariaLabel: string;
  readonly headerNode?: ReactNode;
  readonly feedNode: ReactNode;
  readonly statusNode?: ReactNode;
  readonly composerNode: ReactNode;
  readonly sideNode?: ReactNode;
}

export function ConversationShell({
  className,
  ariaLabel,
  headerNode,
  feedNode,
  statusNode,
  composerNode,
  sideNode,
}: ConversationShellProps): JSX.Element {
  const rootClassName = ["conversation-shell", className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} aria-label={ariaLabel}>
      {headerNode}
      {feedNode}
      {statusNode}
      {composerNode}
      {sideNode}
    </section>
  );
}
