import type {
  LockedComputerControlProjectionV1,
  LockedControlReasonCode,
} from "@ling-stack/contracts";
import { isLockedComputerControlProjectionV1 } from "@ling-stack/contracts";

export type LockedControlDisabledReason =
  | LockedControlReasonCode
  | "locked_control_projection_missing"
  | "locked_control_projection_invalid"
  | "locked_control_computer_control_off"
  | "locked_control_computer_control_not_ready";

export type LockedControlCommand = "authorize" | "revoke";

export type LockedComputerControlViewModel =
  | Readonly<{
      kind: "disabled";
      reason: LockedControlDisabledReason;
      canRecheck: boolean;
      busy: boolean;
      errorMessage?: string;
    }>
  | Readonly<{
      kind: "off";
      terminalReason?: LockedControlReasonCode;
      canAuthorize: true;
      busy: boolean;
      errorMessage?: string;
    }>
  | Readonly<{
      kind: "verifying";
      canRevoke: true;
      busy: boolean;
      errorMessage?: string;
    }>
  | Readonly<{
      kind: "armed" | "active" | "paused" | "expired";
      grantId: string;
      runId: string;
      computerUseSessionId: string;
      issuedAt: string;
      expiresAt: string;
      remainingSeconds: number;
      canRevoke: true;
      reason?: LockedControlReasonCode;
      busy: boolean;
      errorMessage?: string;
    }>;

export function buildLockedComputerControlViewModel(input: {
  readonly projection: unknown;
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly nowMs: number;
  readonly busyAction?: LockedControlCommand;
  readonly commandError?: string;
}): LockedComputerControlViewModel {
  if (input.projection === undefined) {
    return disabled("locked_control_projection_missing", true, Boolean(input.busyAction), input.commandError);
  }
  if (!isLockedComputerControlProjectionV1(input.projection)) {
    return disabled("locked_control_projection_invalid", true, Boolean(input.busyAction), input.commandError);
  }
  const projection: LockedComputerControlProjectionV1 = input.projection;
  if (projection.capability !== "supported_restricted") {
    return disabled(
      projection.reason ?? capabilityFallback(projection.capability),
      projection.capability === "probe_required" || projection.capability === "unsupported",
      Boolean(input.busyAction),
      input.commandError,
    );
  }
  if (!input.requestedEnabled) {
    return disabled("locked_control_computer_control_off", false, Boolean(input.busyAction), input.commandError);
  }
  if (!input.effectiveEnabled) {
    return disabled("locked_control_computer_control_not_ready", true, Boolean(input.busyAction), input.commandError);
  }

  if (projection.phase === "off") {
    if (projection.reason === "locked_control_no_active_run") {
      return disabled(projection.reason, false, Boolean(input.busyAction), input.commandError);
    }
    return {
      kind: "off",
      ...(projection.reason ? { terminalReason: projection.reason } : {}),
      canAuthorize: true,
      busy: input.busyAction !== undefined,
      ...(input.commandError ? { errorMessage: input.commandError } : {}),
    };
  }
  if (projection.phase === "verifying") {
    return {
      kind: "verifying",
      canRevoke: true,
      busy: input.busyAction !== undefined,
      ...(input.commandError ? { errorMessage: input.commandError } : {}),
    };
  }

  const expiresAtMs = Date.parse(projection.expiresAt!);
  const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - input.nowMs) / 1_000));
  const kind = remainingSeconds === 0
    ? "expired"
    : projection.phase === "active_locked"
      ? "active"
      : projection.phase;
  return {
    kind,
    grantId: projection.grantId!,
    runId: projection.runId!,
    computerUseSessionId: projection.computerUseSessionId!,
    issuedAt: projection.issuedAt!,
    expiresAt: projection.expiresAt!,
    remainingSeconds,
    canRevoke: true,
    ...(projection.reason ? { reason: projection.reason } : {}),
    busy: input.busyAction !== undefined,
    ...(input.commandError ? { errorMessage: input.commandError } : {}),
  };
}

function disabled(
  reason: LockedControlDisabledReason,
  canRecheck: boolean,
  busy: boolean,
  errorMessage?: string,
): Extract<LockedComputerControlViewModel, { kind: "disabled" }> {
  return {
    kind: "disabled",
    reason,
    canRecheck,
    busy,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function capabilityFallback(
  capability: Exclude<LockedComputerControlProjectionV1["capability"], "supported_restricted">,
): LockedControlReasonCode {
  if (capability === "disabled_by_build") return "locked_control_disabled_by_build";
  if (capability === "probe_required") return "locked_control_probe_required";
  return "locked_control_platform_unsupported";
}
