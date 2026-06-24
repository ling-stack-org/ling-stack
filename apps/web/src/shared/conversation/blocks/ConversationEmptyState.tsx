import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export interface ConversationEmptyStateProps {
  readonly className?: string;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly loading?: boolean;
}

export function ConversationEmptyState({
  className = "client-empty-state conversation-empty-state",
  icon,
  label,
  loading = false,
}: ConversationEmptyStateProps): JSX.Element {
  return (
    <div className={className}>
      {loading ? <Loader2 className="spin" size={18} /> : icon}
      <span>{label}</span>
    </div>
  );
}
