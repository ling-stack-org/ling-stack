import { useState } from "react";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import type { LockedControlReasonCode } from "@ling-stack/contracts";
import type { ComputerControlController } from "../../../domains/computer-control/use-computer-control-controller.js";
import type { LockedControlDisabledReason } from "../../../domains/computer-control/locked-control-view-model.js";
import { useI18n } from "../../../i18n.js";
import {
  Badge,
  Button,
  DataRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../../shared/ui/index.js";

export function LockedComputerControlSection({
  controller,
}: {
  readonly controller: ComputerControlController;
}): JSX.Element {
  const { t } = useI18n();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const view = controller.lockedView;
  const grantView = view.kind === "armed"
    || view.kind === "active"
    || view.kind === "paused"
    || view.kind === "expired"
    ? view
    : undefined;

  return (
    <section
      className="computer-control-section locked-computer-control-section"
      aria-labelledby="computer-control-privacy-title"
      data-locked-control-state={view.kind}
    >
      <header className="computer-control-section-header">
        <span aria-hidden="true"><LockKeyhole /></span>
        <h2 id="computer-control-privacy-title">{t("Control while locked")}</h2>
      </header>

      {view.kind === "disabled" ? (
        <DataRow
          identity={(
            <span className="computer-control-row-copy">
              <strong>{t("Allow control while locked")}</strong>
              <small>{t(disabledReasonCopy(view.reason))}</small>
            </span>
          )}
          status={<Badge tone="neutral">{t("Unavailable")}</Badge>}
          actions={view.canRecheck ? (
            <Button
              variant="secondary"
              size="sm"
              loading={view.busy}
              onClick={() => void controller.recheck()}
            >
              {t("Recheck")}
            </Button>
          ) : undefined}
        />
      ) : null}

      {view.kind === "off" ? (
        <DataRow
          identity={(
            <span className="computer-control-row-copy">
              <strong>{t("Allow control while locked")}</strong>
              <small>{t("A short-lived authorization applies only to the current active task and one lock transition.")}</small>
            </span>
          )}
          status={<Badge tone="neutral">{t("Off")}</Badge>}
          actions={(
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<ShieldAlert />}
              loading={view.busy}
              disabled={view.busy}
              onClick={() => setConfirmationOpen(true)}
            >
              {t("Authorize for this task")}
            </Button>
          )}
        />
      ) : null}

      {view.kind === "verifying" ? (
        <DataRow
          identity={(
            <span className="computer-control-row-copy">
              <strong>{t("Verifying your identity")}</strong>
              <small>{t("Complete the system-owned identity prompt while the computer is unlocked.")}</small>
            </span>
          )}
          status={<Badge tone="info">{t("Verifying")}</Badge>}
          actions={<RevokeButton controller={controller} busy={view.busy} />}
        />
      ) : null}

      {grantView ? (
        <DataRow
          identity={(
            <span className="computer-control-row-copy">
              <strong>{t(grantStateTitle(grantView.kind))}</strong>
              <small>
                {t("Task")} {compactId(grantView.runId)} · {formatExpiry(grantView.expiresAt)} · {formatCountdown(grantView.remainingSeconds)}
              </small>
              {grantView.kind === "paused" && grantView.reason ? (
                <small>{t(reasonCopy(grantView.reason))}</small>
              ) : null}
            </span>
          )}
          status={<Badge tone={grantStateTone(grantView.kind)}>{t(grantStateBadge(grantView.kind))}</Badge>}
          actions={<RevokeButton controller={controller} busy={grantView.busy} />}
        />
      ) : null}

      {view.errorMessage ? <InlineFeedback tone="danger">{t(commandErrorCopy(view.errorMessage))}</InlineFeedback> : null}

      <Dialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <DialogContent size="sm" className="locked-computer-control-dialog">
          <DialogHeader
            title={t("Authorize control while locked?")}
            closeLabel={t("Close")}
          />
          <DialogBody>
            <p>{t("Ling will ask the operating system to verify the local user before creating this authorization.")}</p>
            <ul>
              <li>{t("It applies only to the current active Computer Use task.")}</li>
              <li>{t("It expires after at most 15 minutes and is consumed after one unlock.")}</li>
              <li>{t("Existing tool approvals still apply; approval-required actions pause while locked.")}</li>
              <li>{t("Login, authentication, UAC and other secure surfaces are never controlled.")}</li>
              <li>{t("You can revoke it from Settings or stop Computer Use at any time.")}</li>
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmationOpen(false)}>{t("Cancel")}</Button>
            <Button
              variant="primary"
              leadingIcon={<ShieldAlert />}
              onClick={() => {
                setConfirmationOpen(false);
                void controller.authorizeLockedControl();
              }}
            >
              {t("Continue to system verification")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RevokeButton({
  busy,
  controller,
}: {
  readonly busy: boolean;
  readonly controller: ComputerControlController;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Button
      variant="danger"
      size="sm"
      loading={busy}
      disabled={busy}
      onClick={() => void controller.revokeLockedControl()}
    >
      {t("Revoke")}
    </Button>
  );
}

function disabledReasonCopy(reason: LockedControlDisabledReason): string {
  if (reason === "locked_control_disabled_by_build" || reason === "locked_control_projection_missing") {
    return "Not available in this version.";
  }
  if (reason === "locked_control_disabled_by_policy") return "Managed by policy.";
  if (reason === "locked_control_computer_control_off") return "Turn on Computer Control first.";
  if (reason === "locked_control_computer_control_not_ready") return "Finish Computer Control system readiness first.";
  if (reason === "locked_control_no_active_run") return "Start an active Computer Use task first.";
  if (reason === "locked_control_probe_required") return "A platform safety check is still required.";
  if (reason === "locked_control_platform_unsupported") return "This platform cannot safely control the current session while locked.";
  if (reason === "locked_control_projection_invalid") return "The locked-control state is invalid, so Ling kept it unavailable.";
  return reasonCopy(reason);
}

function reasonCopy(reason: LockedControlReasonCode): string {
  const values: Partial<Record<LockedControlReasonCode, string>> = {
    locked_control_identity_cancelled: "Identity verification was cancelled.",
    locked_control_identity_failed: "Identity verification failed.",
    locked_control_identity_unavailable: "Identity verification is unavailable.",
    locked_control_grant_expired: "The authorization expired.",
    locked_control_grant_consumed: "The authorization was used and consumed on unlock.",
    locked_control_approval_required: "An action needs approval; locked control is paused.",
    locked_control_secure_surface: "A secure surface was detected; control was stopped.",
    locked_control_session_mismatch: "The active user session changed; control was stopped.",
    locked_control_suspend: "The computer suspended; authorization was revoked.",
    locked_control_authority_rotated: "Desktop authority changed; authorization was revoked.",
  };
  return values[reason] ?? "Locked control is unavailable for safety.";
}

function commandErrorCopy(reason: string): string {
  return reason.startsWith("locked_control_")
    ? reasonCopy(reason as LockedControlReasonCode)
    : reason;
}

function grantStateTitle(kind: "armed" | "active" | "paused" | "expired"): string {
  if (kind === "armed") return "Authorized for the next lock";
  if (kind === "active") return "Controlling while locked";
  if (kind === "paused") return "Locked control paused";
  return "Authorization expired";
}

function grantStateBadge(kind: "armed" | "active" | "paused" | "expired"): string {
  if (kind === "armed") return "Armed";
  if (kind === "active") return "Active";
  if (kind === "paused") return "Paused";
  return "Expired";
}

function grantStateTone(kind: "armed" | "active" | "paused" | "expired"): "success" | "info" | "warning" | "danger" {
  if (kind === "armed") return "success";
  if (kind === "active") return "info";
  if (kind === "paused") return "warning";
  return "danger";
}

function compactId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatExpiry(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
