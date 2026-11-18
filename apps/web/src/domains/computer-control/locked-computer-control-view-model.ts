import { isLockedComputerControlProjectionV1 } from "@ling-stack/contracts";
import type { LockedComputerControlDesktopState } from "../../../../desktop/shared/desktop-capabilities.js";

export type LockedControlPendingCommand = "authorize" | "revoke";

export function parseLockedComputerControlDesktopState(value: unknown): LockedComputerControlDesktopState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "projection" && key !== "activeTaskAvailable")
    || typeof record.activeTaskAvailable !== "boolean"
    || !isLockedComputerControlProjectionV1(record.projection)) return undefined;
  return { projection: record.projection, activeTaskAvailable: record.activeTaskAvailable };
}

export function buildLockedComputerControlView(input: {
  readonly state?: LockedComputerControlDesktopState;
  readonly computerControlReady: boolean;
  readonly readFailed: boolean;
  readonly pending?: LockedControlPendingCommand;
  readonly commandError?: string;
}) {
  const projection = input.state?.projection;
  const supported = projection?.capability === "supported_restricted";
  const phase = input.pending === "authorize" ? "verifying" : projection?.phase ?? "off";
  const hasAuthorization = projection !== undefined && projection.phase !== "off";
  const canRevoke = hasAuthorization || input.pending !== undefined;
  const policyBlocked = ["locked_control_disabled_by_build", "locked_control_disabled_by_policy",
    "locked_control_probe_required", "locked_control_platform_unsupported"].includes(projection?.reason ?? "");
  const canAuthorize = supported && !policyBlocked && !input.readFailed && !input.pending && phase === "off"
    && input.computerControlReady && input.state?.activeTaskAvailable === true;
  const states = {
    off: ["Control while locked", "Off", "neutral"],
    verifying: ["Verifying your identity", "Verifying", "info"],
    armed: ["Authorized for the next lock", "Armed", "success"],
    active_locked: ["Controlling while locked", "Controlling while locked", "success"],
    paused: ["Locked control paused", "Paused while locked", "warning"],
  } as const;
  const [title, badge, tone] = states[phase];
  const description = phase === "verifying"
    ? "Complete the system-owned identity prompt while the computer is unlocked."
    : phase === "off" && !input.computerControlReady
      ? "Finish Computer Control system readiness first."
      : phase === "off" && !input.state?.activeTaskAvailable
        ? "Start an active Computer Use task first."
        : "A short-lived authorization applies only to the current active task and one lock transition.";
  return {
    governed: supported || canRevoke,
    phase,
    title: input.readFailed ? "Locked control is unavailable for safety." : title,
    badge: input.readFailed ? "Needs attention" : badge,
    tone: input.readFailed ? "warning" as const : tone,
    description,
    canAuthorize,
    canRevoke,
    expiresAt: projection?.expiresAt,
    feedback: input.readFailed
      ? "The locked-control state could not be refreshed. Authorization is unavailable until it can be checked."
      : input.commandError
        ? lockedControlReasonCopy(input.commandError)
        : projection?.reason && supported ? lockedControlReasonCopy(projection.reason) : undefined,
  };
}

export function lockedControlReasonCopy(reason: string): string | undefined {
  if (reason === "locked_control_grant_consumed") return undefined;
  const messages: Readonly<Record<string, string>> = {
    locked_control_identity_cancelled: "Identity verification was cancelled.",
    locked_control_identity_failed: "Identity verification failed.",
    locked_control_identity_unavailable: "Identity verification is unavailable.",
    locked_control_no_active_run: "Start an active Computer Use task first.",
    locked_control_grant_expired: "The authorization expired.",
    locked_control_approval_required: "An action needs approval; locked control is paused.",
    locked_control_secure_surface: "A secure surface was detected; control was stopped.",
    locked_control_user_switched: "The active user session changed; control was stopped.",
    locked_control_session_mismatch: "Unlock the computer and return to the desktop.",
    locked_control_suspend: "The computer suspended; authorization was revoked.",
    locked_control_authority_rotated: "Desktop authority changed; authorization was revoked.",
    locked_control_disabled_by_build: "Not available in this version.",
    locked_control_disabled_by_policy: "Managed by policy.",
    locked_control_probe_required: "A platform safety check is still required.",
    locked_control_platform_unsupported: "This platform cannot safely control the current session while locked.",
  };
  return messages[reason] ?? "Locked control is unavailable for safety.";
}
