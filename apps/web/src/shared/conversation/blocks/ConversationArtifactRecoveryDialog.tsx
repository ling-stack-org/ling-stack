import { Redo2, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  reapplyTurnWorkspaceChanges,
  reapplyRunWorkspaceChanges,
  reapplyWorkflowWorkspaceChanges,
  undoTurnWorkspaceChanges,
  undoRunWorkspaceChanges,
  undoWorkflowWorkspaceChanges,
} from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { ConversationWorkspaceRecoveryTarget } from "../../../lib/conversation-work-cell.js";
import type { RunWorkspaceChangesResponse, TurnWorkspaceChangesResponse, WorkflowWorkspaceChangesResponse } from "../../../types.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../ui/index.js";

export type ConversationArtifactRecoveryAction = "undo" | "reapply";
export type ConversationArtifactRecoveryResponse = RunWorkspaceChangesResponse | TurnWorkspaceChangesResponse | WorkflowWorkspaceChangesResponse;

export function ConversationArtifactRecoveryDialog({
  action,
  cwd,
  fileCount,
  returnFocusRef,
  target,
  onClose,
  onRecovered,
}: {
  readonly action?: ConversationArtifactRecoveryAction;
  readonly cwd?: string;
  readonly fileCount: number;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly target?: ConversationWorkspaceRecoveryTarget;
  readonly onClose: () => void;
  readonly onRecovered: (response: ConversationArtifactRecoveryResponse) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inFlightRef = useRef(false);
  const lastActionRef = useRef<ConversationArtifactRecoveryAction>("undo");
  const idempotencyKeyRef = useRef<string | undefined>(undefined);
  if (action) lastActionRef.current = action;
  useEffect(() => {
    idempotencyKeyRef.current = action && target?.kind === "turn"
      ? createRecoveryIdempotencyKey()
      : undefined;
  }, [action, target?.id, target?.kind]);
  const visibleAction = action ?? lastActionRef.current;
  const title = visibleAction === "undo"
    ? t("Undo changes to {count} files?", { count: fileCount })
    : t("Reapply changes to {count} files?", { count: fileCount });

  function close(): void {
    if (inFlightRef.current) return;
    setError("");
    idempotencyKeyRef.current = undefined;
    onClose();
  }

  async function confirm(): Promise<void> {
    if (!action || !cwd || !target || inFlightRef.current) return;
    const requestedAction = action;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const idempotencyKey = target.kind === "turn"
        ? idempotencyKeyRef.current ?? createRecoveryIdempotencyKey()
        : undefined;
      idempotencyKeyRef.current = idempotencyKey;
      const response = await mutateWorkspaceRecovery(cwd, target, requestedAction, idempotencyKey);
      setError("");
      onRecovered(response);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      busy={busy}
      open={Boolean(action && cwd && target)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-ui2-conversation-artifact-recovery-dialog={visibleAction}
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          globalThis.requestAnimationFrame(() => {
            if (returnFocusRef.current?.isConnected) {
              returnFocusRef.current.focus({ preventScroll: true });
            }
          });
        }}
      >
        <DialogHeader title={title} description={t("Workspace changes")} />
        <DialogBody>
          {error ? (
            <InlineFeedback role="alert" title={t("Error")} tone="danger">
              {error}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            ref={cancelRef}
            disabled={busy}
            size="sm"
            variant="secondary"
            onClick={close}
          >
            {error ? t("Close") : t("Cancel")}
          </Button>
          <Button
            leadingIcon={error
              ? <RefreshCw aria-hidden="true" size={14} />
              : visibleAction === "undo"
                ? <Undo2 aria-hidden="true" size={14} />
                : <Redo2 aria-hidden="true" size={14} />}
            loading={busy}
            loadingLabel={t("Loading")}
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
          >
            {error ? t("Retry") : visibleAction === "undo" ? t("Undo") : t("Reapply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createRecoveryIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function mutateWorkspaceRecovery(
  cwd: string,
  target: ConversationWorkspaceRecoveryTarget,
  action: ConversationArtifactRecoveryAction,
  idempotencyKey?: string,
): Promise<ConversationArtifactRecoveryResponse> {
  if (target.kind === "workflow") {
    return action === "undo"
      ? undoWorkflowWorkspaceChanges(cwd, target.id)
      : reapplyWorkflowWorkspaceChanges(cwd, target.id);
  }
  if (target.kind === "turn") {
    if (!idempotencyKey) {
      return Promise.reject(new Error("A recovery idempotency key is required."));
    }
    return action === "undo"
      ? undoTurnWorkspaceChanges(cwd, target.id, idempotencyKey)
      : reapplyTurnWorkspaceChanges(cwd, target.id, idempotencyKey);
  }
  return action === "undo"
    ? undoRunWorkspaceChanges(cwd, target.id)
    : reapplyRunWorkspaceChanges(cwd, target.id);
}
