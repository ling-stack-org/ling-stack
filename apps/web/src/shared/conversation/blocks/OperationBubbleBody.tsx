import type { ReactNode } from "react";

export interface OperationBubbleBodyProps {
  readonly children: ReactNode;
}

export function OperationBubbleBody({ children }: OperationBubbleBodyProps): JSX.Element {
  return (
    <div className="conversation-operation-bubble-body">
      {children}
    </div>
  );
}
