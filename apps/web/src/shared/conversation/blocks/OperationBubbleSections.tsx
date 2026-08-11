import type { ReactNode } from "react";

export interface OperationBubbleSectionProps {
  readonly children: ReactNode;
  readonly label?: string;
}

export function OperationBubbleSection({
  children,
  label,
}: OperationBubbleSectionProps): React.JSX.Element {
  return (
    <section className="conversation-operation-bubble-section" aria-label={label}>
      {children}
    </section>
  );
}
