import { useEffect, useState } from "react";
import { useI18n } from "../../i18n.js";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "../../shared/ui/index.js";
import type { ChannelExecutionProposal, ChannelMention, UpdateChannelExecutionProposalRequest } from "../../types.js";
import { ChannelExecutionProposalDecision } from "./ChannelWorkflowProposalCards.js";

export function ChannelExecutionProposalDialog({
  proposal,
  assigneeLabel,
  teammates,
  onClose,
  onConfirm,
  onCancel,
  onUpdate,
  onOpenRun,
  onRepairModelBinding,
}: {
  readonly proposal: ChannelExecutionProposal | undefined;
  readonly assigneeLabel: string;
  readonly teammates: readonly ChannelMention[];
  readonly onClose: () => void;
  readonly onConfirm: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly onCancel: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly onUpdate: (
    proposal: ChannelExecutionProposal,
    input: UpdateChannelExecutionProposalRequest,
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly onOpenRun: (runId: string) => void;
  readonly onRepairModelBinding: (blocker: NonNullable<ChannelExecutionProposal["blocker"]>) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [busyAction, setBusyAction] = useState<"confirm" | "cancel" | "">("");

  useEffect(() => {
    setBusyAction("");
  }, [proposal?.id, proposal?.status, proposal?.updatedAt]);

  if (!proposal) return null;
  const activeProposal = proposal;
  const busy = Boolean(busyAction);

  async function runAction(action: "confirm" | "cancel"): Promise<void> {
    if (busy) return;
    setBusyAction(action);
    try {
      if (action === "confirm") {
        await onConfirm(activeProposal);
      } else {
        await onCancel(activeProposal);
      }
    } finally {
      setBusyAction("");
    }
  }

  return (
    <Dialog busy={busy} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="channel-execution-proposal-dialog" size="lg">
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Task confirmation")}
        />
        <DialogBody className="channel-execution-proposal-dialog-body">
          <ChannelExecutionProposalDecision
            actionBusy={busyAction}
            proposal={activeProposal}
            assigneeLabel={assigneeLabel}
            teammates={teammates}
            onConfirm={() => void runAction("confirm")}
            onCancel={() => void runAction("cancel")}
            onUpdate={onUpdate}
            onOpenRun={onOpenRun}
            onRepairModelBinding={onRepairModelBinding}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
