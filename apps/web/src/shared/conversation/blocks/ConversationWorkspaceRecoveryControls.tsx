import { useRef, useState } from "react";
import { Loader2, Redo2, Undo2 } from "lucide-react";
import type { ConversationWorkspaceRecoveryTarget } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { useWorkspaceRecovery, type WorkspaceRecoveryResource } from "./workspace-recovery-resource.js";
import {
  ConversationArtifactRecoveryDialog,
  type ConversationArtifactRecoveryAction,
} from "./ConversationArtifactRecoveryDialog.js";

export function ConversationWorkspaceRecoveryControls({
  className,
  cwd,
  fileCountFallback,
  target,
  resource,
}: {
  readonly className?: string;
  readonly cwd?: string;
  readonly fileCountFallback: number;
  readonly target?: ConversationWorkspaceRecoveryTarget;
  readonly resource?: WorkspaceRecoveryResource;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [action, setAction] = useState<ConversationArtifactRecoveryAction>();
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const normalizedCwd = cwd?.trim();
  const ownResource = useWorkspaceRecovery(normalizedCwd, resource ? undefined : target);
  const activeResource = resource ?? ownResource;
  const { recovery, status } = activeResource;

  if (!normalizedCwd || !target) return null;

  const unavailableReason = recovery?.unavailableReason ?? t("Undo is unavailable for this work");
  return (
    <span
      className={["conversation-workspace-recovery-controls", className].filter(Boolean).join(" ")}
      data-conversation-workspace-recovery={target.kind}
    >
      {recovery?.canReapply ? (
        <button
          ref={actionRef}
          type="button"
          data-conversation-workspace-recovery-action="reapply"
          onClick={() => setAction("reapply")}
        >
          <Redo2 size={13} aria-hidden="true" />
          {t("Reapply")}
        </button>
      ) : (
        <button
          ref={actionRef}
          type="button"
          data-conversation-workspace-recovery-action="undo"
          onClick={() => setAction("undo")}
          disabled={status !== "loaded" || !recovery?.canUndo}
          title={recovery?.canUndo ? undefined : unavailableReason}
        >
          {status === "loading" ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <Undo2 size={13} aria-hidden="true" />}
          {t("Undo")}
        </button>
      )}
      <ConversationArtifactRecoveryDialog
        action={action}
        cwd={normalizedCwd}
        fileCount={recovery?.summary.fileCount ?? fileCountFallback}
        returnFocusRef={actionRef}
        target={target}
        onClose={() => setAction(undefined)}
        onRecovered={(response) => {
          activeResource.update(response);
        }}
      />
    </span>
  );
}
