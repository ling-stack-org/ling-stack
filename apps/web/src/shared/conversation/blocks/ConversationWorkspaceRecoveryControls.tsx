import { useEffect, useRef, useState } from "react";
import { Loader2, Redo2, Undo2 } from "lucide-react";
import type { ConversationWorkspaceRecoveryTarget } from "@ling-stack/conversation-ui-core";
import {
  getRunWorkspaceChanges,
  getTurnWorkspaceChanges,
  getWorkflowWorkspaceChanges,
} from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type {
  RunWorkspaceChangesResponse,
  TurnWorkspaceChangesResponse,
  WorkflowWorkspaceChangesResponse,
} from "../../../types.js";
import {
  ConversationArtifactRecoveryDialog,
  type ConversationArtifactRecoveryAction,
} from "./ConversationArtifactRecoveryDialog.js";

type ConversationWorkspaceRecoveryResponse =
  | RunWorkspaceChangesResponse
  | TurnWorkspaceChangesResponse
  | WorkflowWorkspaceChangesResponse;

export function ConversationWorkspaceRecoveryControls({
  className,
  cwd,
  fileCountFallback,
  target,
}: {
  readonly className?: string;
  readonly cwd?: string;
  readonly fileCountFallback: number;
  readonly target?: ConversationWorkspaceRecoveryTarget;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [recovery, setRecovery] = useState<ConversationWorkspaceRecoveryResponse>();
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "unavailable">("idle");
  const [action, setAction] = useState<ConversationArtifactRecoveryAction>();
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const normalizedCwd = cwd?.trim();

  useEffect(() => {
    if (!normalizedCwd || !target) {
      setRecovery(undefined);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setRecovery(undefined);
    setStatus("loading");
    void getWorkspaceRecovery(normalizedCwd, target).then((response) => {
      if (!cancelled) {
        setRecovery(response);
        setStatus("loaded");
      }
    }, () => {
      if (!cancelled) {
        setRecovery(undefined);
        setStatus("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedCwd, target?.id, target?.kind]);

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
          setRecovery(response);
          setStatus("loaded");
        }}
      />
    </span>
  );
}

function getWorkspaceRecovery(
  cwd: string,
  target: ConversationWorkspaceRecoveryTarget,
): Promise<ConversationWorkspaceRecoveryResponse> {
  return target.kind === "workflow"
    ? getWorkflowWorkspaceChanges(cwd, target.id)
    : target.kind === "turn"
      ? getTurnWorkspaceChanges(cwd, target.id)
      : getRunWorkspaceChanges(cwd, target.id);
}
