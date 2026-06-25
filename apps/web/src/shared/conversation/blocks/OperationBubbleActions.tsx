import type { ReactNode } from "react";

export interface OperationBubbleActionsProps {
  readonly children?: ReactNode;
}

export function OperationBubbleActions({ children }: OperationBubbleActionsProps): JSX.Element | null {
  if (!children) {
    return null;
  }
  return (
    <div className="conversation-operation-bubble-actions">
      {children}
    </div>
  );
}
