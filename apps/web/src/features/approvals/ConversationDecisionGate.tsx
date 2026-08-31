import { Check, ChevronDown, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SplitButton,
  SplitButtonPrimary,
  SplitButtonTrigger,
} from "../../shared/ui/index.js";

export type ConversationDecisionAction = "allow" | "allow_secondary" | "deny";

export function ConversationDecisionGate({
  allowLabel,
  allowMenuLabel,
  allowSecondaryDescription,
  allowSecondaryLabel,
  allowingLabel,
  allowingSecondaryLabel,
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
  onAllowSecondary,
  onDeny,
}: {
  readonly allowLabel: string;
  readonly allowMenuLabel?: string;
  readonly allowSecondaryDescription?: string;
  readonly allowSecondaryLabel?: string;
  readonly allowingLabel: string;
  readonly allowingSecondaryLabel?: string;
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
  readonly onAllowSecondary?: () => void;
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
          disabled={Boolean(busyAction)}
          loading={busyAction === "deny"}
          loadingLabel={denyingLabel}
          variant="secondary"
          onClick={onDeny}
        >
          {errorMessage && attemptedAction === "deny" ? retryLabel : denyLabel}
        </Button>
        {allowSecondaryLabel && onAllowSecondary ? (
          <SplitButton
            aria-label={allowMenuLabel ?? allowLabel}
            className="conversation-decision-split-button"
            role="group"
          >
            <SplitButtonPrimary
              disabled={Boolean(busyAction)}
              leadingIcon={<Check aria-hidden="true" size={15} />}
              loading={busyAction === "allow" || busyAction === "allow_secondary"}
              loadingLabel={busyAction === "allow_secondary" ? allowingSecondaryLabel ?? allowingLabel : allowingLabel}
              variant="primary"
              onClick={onAllow}
            >
              {errorMessage && attemptedAction === "allow" ? retryLabel : allowLabel}
            </SplitButtonPrimary>
            <Menu modal={false}>
              <MenuTrigger asChild>
                <SplitButtonTrigger
                  disabled={Boolean(busyAction)}
                  icon={ChevronDown}
                  label={allowMenuLabel ?? allowLabel}
                  tooltip=""
                  variant="primary"
                />
              </MenuTrigger>
              <MenuContent align="end" className="conversation-decision-allow-menu" side="top">
                <MenuItem onSelect={onAllow}>
                  <span className="conversation-decision-menu-label">{allowLabel}</span>
                </MenuItem>
                <MenuItem data-command-rule-decision="true" onSelect={onAllowSecondary}>
                  <span className="conversation-decision-menu-copy">
                    <span className="conversation-decision-menu-label">
                      {errorMessage && attemptedAction === "allow_secondary" ? retryLabel : allowSecondaryLabel}
                    </span>
                    {allowSecondaryDescription ? (
                      <span className="conversation-decision-menu-description">{allowSecondaryDescription}</span>
                    ) : null}
                  </span>
                </MenuItem>
              </MenuContent>
            </Menu>
          </SplitButton>
        ) : (
          <Button
            disabled={Boolean(busyAction)}
            leadingIcon={<Check aria-hidden="true" size={15} />}
            loading={busyAction === "allow"}
            loadingLabel={allowingLabel}
            variant="primary"
            onClick={onAllow}
          >
            {errorMessage && attemptedAction === "allow" ? retryLabel : allowLabel}
          </Button>
        )}
      </div>
    </section>
  );
}
