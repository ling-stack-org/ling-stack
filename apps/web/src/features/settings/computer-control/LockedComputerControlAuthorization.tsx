import { useEffect, useState } from "react";
import { useLockedComputerControl } from "../../../domains/computer-control/use-locked-computer-control.js";
import { useI18n } from "../../../i18n.js";
import {
  Badge, Button, DataRow, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTrigger, InlineFeedback,
} from "../../../shared/ui/index.js";

export function LockedComputerControlAuthorization({ computerControlReady }: {
  readonly computerControlReady: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const controller = useLockedComputerControl(computerControlReady);
  const { view, pending } = controller;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!view.canAuthorize) setConfirming(false); }, [view.canAuthorize]);
  return (
    <div className="locked-computer-control-section" data-locked-control-state={view.governed ? view.phase : "unavailable"}>
      {view.governed ? (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DataRow
            identity={(
              <span className="computer-control-row-copy">
                <strong>{t(view.title)}</strong>
                <small>{t(view.description)}</small>
                {view.expiresAt ? <small>{t("Expires at")} <time dateTime={view.expiresAt}>{new Date(view.expiresAt).toLocaleString()}</time></small> : null}
              </span>
            )}
            status={<Badge tone={view.tone}>{t(view.badge)}</Badge>}
            actions={view.canRevoke ? (
              <Button variant="secondary" loading={pending === "revoke"} onClick={() => void controller.revoke()}>{t("Revoke")}</Button>
            ) : (
              <DialogTrigger asChild>
                <Button variant="secondary" disabled={!view.canAuthorize}>{t("Authorize for this task")}</Button>
              </DialogTrigger>
            )}
          />
            <DialogContent size="sm" className="locked-computer-control-dialog" onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              setConfirming(false);
            }}>
              <DialogHeader title={t("Authorize control while locked?")} closeLabel={t("Cancel")}
                description={t("A short-lived authorization applies only to the current active task and one lock transition.")} />
              <DialogBody>
                <p>{t("Ling will ask the operating system to verify the local user before creating this authorization.")}</p>
                <ul>
                  <li>{t("It applies only to the current active Computer Use task.")}</li>
                  <li>{t("Ling temporarily unlocks your session behind protected screens. Local input stops control and relocks the computer.")}</li>
                  <li>{t("Existing tool approvals still apply; approval-required actions pause while locked.")}</li>
                  <li>{t("You can revoke it from Settings or stop Computer Use at any time.")}</li>
                </ul>
              </DialogBody>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirming(false)}>{t("Cancel")}</Button>
                <Button variant="primary" disabled={!view.canAuthorize} onClick={() => { setConfirming(false); void controller.authorize(); }}>
                  {t("Continue to system verification")}
                </Button>
              </DialogFooter>
            </DialogContent>
        </Dialog>
      ) : (
        <>
          <DataRow
            identity={<span className="computer-control-row-copy"><strong>{t("Computer Control pauses")}</strong><small>{t("Screen capture and input stop. Ling never interacts with the lock screen, login window, password fields, or secure desktop.")}</small></span>}
            status={<Badge tone="warning">{t("Paused while locked")}</Badge>}
          />
          <DataRow
            identity={<span className="computer-control-row-copy"><strong>{t("Control resumes after unlock")}</strong><small>{t("Ling rechecks permissions, the interactive session, and a fresh Driver generation before restoring control.")}</small></span>}
            status={<Badge tone="info">{t("Resumes automatically")}</Badge>}
          />
        </>
      )}
      {view.feedback ? <InlineFeedback aria-live="polite" tone="warning">{t(view.feedback)}</InlineFeedback> : null}
    </div>
  );
}
