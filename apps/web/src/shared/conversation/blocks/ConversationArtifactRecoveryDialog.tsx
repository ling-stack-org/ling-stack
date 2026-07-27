import { Redo2, RefreshCw, Undo2 } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import {
  reapplyRunWorkspaceChanges,
  reapplyWorkflowWorkspaceChanges,
  undoRunWorkspaceChanges,
  undoWorkflowWorkspaceChanges,
} from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { ConversationWorkspaceRecoveryTarget } from "../../../lib/conversation-work-cell.js";
import type { RunWorkspaceChangesResponse, WorkflowWorkspaceChangesResponse } from "../../../types.js";
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
export type ConversationArtifactRecoveryResponse = RunWorkspaceChangesResponse | WorkflowWorkspaceChangesResponse;

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
}): JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inFlightRef = useRef(false);
  const lastActionRef = useRef<ConversationArtifactRecoveryAction>("undo");
  if (action) lastActionRef.current = action;
  const visibleAction = action ?? lastActionRef.current;
  const title = visibleAction === "undo"
    ? t("Undo changes to {count} files?", { count: fileCount })
    : t("Reapply changes to {count} files?", { count: fileCount });

  function close(): void {
    if (inFlightRef.current) return;
    setError("");
    onClose();
  }

  async function confirm(): Promise<void> {
    if (!action || !cwd || !target || inFlightRef.current) return;
    const requestedAction = action;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const response = await mutateWorkspaceRecovery(cwd, target, requestedAction);
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

function mutateWorkspaceRecovery(
  cwd: string,
  target: ConversationWorkspaceRecoveryTarget,
  action: ConversationArtifactRecoveryAction,
): Promise<ConversationArtifactRecoveryResponse> {
  if (target.kind === "workflow") {
    return action === "undo"
      ? undoWorkflowWorkspaceChanges(cwd, target.id)
      : reapplyWorkflowWorkspaceChanges(cwd, target.id);
  }
  return action === "undo"
    ? undoRunWorkspaceChanges(cwd, target.id)
    : reapplyRunWorkspaceChanges(cwd, target.id);
}
