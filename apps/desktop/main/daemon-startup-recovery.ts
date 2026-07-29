import {
  DesktopDaemonLifecycleError,
  type DesktopDaemonLifecycle,
  type DesktopDaemonPortOccupant,
} from "./daemon-lifecycle.js";
import {
  resolveDesktopStartupFailure,
  type DesktopStartupFailureDecision,
  type DesktopStartupFailurePrompt,
} from "./startup-failure-recovery.js";

export type DesktopDaemonStartupRecoveryDecision = "retry" | "quit";
export type DesktopDaemonStartupFailureDecision = DesktopStartupFailureDecision;

export interface DesktopDaemonStartupRecoveryPrompt {
  readonly baseUrl: string;
  readonly reason: "bridge_incompatible";
  readonly occupant: DesktopDaemonPortOccupant;
}

export type DesktopDaemonStartupFailurePrompt = DesktopStartupFailurePrompt & { readonly baseUrl: string };

export async function ensureDesktopDaemonWithStartupRecovery(input: {
  readonly daemon: Pick<DesktopDaemonLifecycle, "ensureStarted">;
  readonly allowInteractiveRecovery: boolean;
  readonly prompt: (
    input: DesktopDaemonStartupRecoveryPrompt,
  ) => Promise<DesktopDaemonStartupRecoveryDecision>;
  readonly promptStartupFailure?: (
    input: DesktopDaemonStartupFailurePrompt,
  ) => Promise<DesktopDaemonStartupFailureDecision>;
  readonly openDiagnostics?: () => Promise<void> | void;
}): Promise<"connected" | "quit"> {
  while (true) {
    try {
      await input.daemon.ensureStarted();
      return "connected";
    } catch (error) {
      if (!input.allowInteractiveRecovery || !(error instanceof DesktopDaemonLifecycleError)) {
        throw error;
      }
      if (error.code === "bridge_incompatible") {
        const decision = await input.prompt({
          baseUrl: error.baseUrl,
          reason: error.code,
          occupant: error.occupant ?? "ling_daemon",
        });
        if (decision === "quit") {
          return "quit";
        }
        continue;
      }
      if (!input.promptStartupFailure) {
        throw error;
      }
      const decision = await resolveDesktopStartupFailure({
        prompt: {
          baseUrl: error.baseUrl,
          reason: error.code,
        },
        decide: input.promptStartupFailure,
        openDiagnostics: input.openDiagnostics,
      });
      if (decision === "quit") {
        return "quit";
      }
    }
  }
}
