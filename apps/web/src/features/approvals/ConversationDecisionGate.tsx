import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";

export type ConversationDecisionAction = "allow" | "deny";

export function ConversationDecisionGate({
  allowLabel,
  allowingLabel,
  attemptedAction,
  busyAction,
  className,
  decisionId,
  decisionKind,
  denyLabel,
  denyingLabel,
  description,
  errorMessage,
  focusKey,
  icon,
  retryLabel,
  surface,
  title,
  onAllow,
  onDeny,
}: {
  readonly allowLabel: string;
  readonly allowingLabel: string;
  readonly attemptedAction?: ConversationDecisionAction;
  readonly busyAction?: ConversationDecisionAction;
  readonly className?: string;
  readonly decisionId: string;
  readonly decisionKind: "runtime_approval" | "task_proposal";
  readonly denyLabel: string;
  readonly denyingLabel: string;
  readonly description: string;
  readonly errorMessage?: string;
  readonly focusKey: string;
  readonly icon?: ReactNode;
  readonly retryLabel: string;
  readonly surface: "channel" | "normal_conversation" | "teammate_direct";
  readonly title: string;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}): React.JSX.Element {
  const denyButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => denyButtonRef.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [focusKey]);

  return (
    <section
      aria-label={title}
      className={`conversation-composer conversation-decision-gate${className ? ` ${className}` : ""}`}
      data-channel-execution-proposal-id={decisionKind === "task_proposal" ? decisionId : undefined}
      data-computer-use-obstacle="true"
      data-computer-use-obstacle-kind="approval"
      data-conversation-composer="true"
      data-conversation-decision-kind={decisionKind}
      data-runtime-approval-id={decisionKind === "runtime_approval" ? decisionId : undefined}
      data-surface={surface}
    >
      <div className="conversation-decision-gate-copy">
        <span className="conversation-decision-gate-icon" aria-hidden="true">
          {icon ?? <ShieldCheck size={18} />}
        </span>
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
      </div>
      {errorMessage ? (
        <p className="conversation-decision-gate-error" role="alert">{errorMessage}</p>
      ) : null}
      <div className="conversation-decision-gate-actions">
        <Button
          ref={denyButtonRef}
          leadingIcon={<X aria-hidden="true" size={15} />}
          loading={busyAction === "deny"}
          loadingLabel={denyingLabel}
          variant="secondary"
          onClick={onDeny}
        >
          {errorMessage && attemptedAction === "deny" ? retryLabel : denyLabel}
        </Button>
        <Button
          leadingIcon={<Check aria-hidden="true" size={15} />}
          loading={busyAction === "allow"}
          loadingLabel={allowingLabel}
          variant="primary"
          onClick={onAllow}
        >
          {errorMessage && attemptedAction === "allow" ? retryLabel : allowLabel}
        </Button>
      </div>
    </section>
  );
}
