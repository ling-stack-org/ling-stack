import {
  DesktopDaemonLifecycleError,
  type DesktopDaemonLifecycle,
  type DesktopDaemonPortOccupant,
} from "./daemon-lifecycle.js";

export type DesktopDaemonStartupRecoveryDecision = "retry" | "quit";

export interface DesktopDaemonStartupRecoveryPrompt {
  readonly baseUrl: string;
  readonly reason: "bridge_incompatible";
  readonly occupant: DesktopDaemonPortOccupant;
}

export async function ensureDesktopDaemonWithStartupRecovery(input: {
  readonly daemon: Pick<DesktopDaemonLifecycle, "ensureStarted">;
  readonly allowInteractiveRecovery: boolean;
  readonly prompt: (
    input: DesktopDaemonStartupRecoveryPrompt,
  ) => Promise<DesktopDaemonStartupRecoveryDecision>;
}): Promise<"connected" | "quit"> {
  while (true) {
    try {
      await input.daemon.ensureStarted();
      return "connected";
    } catch (error) {
      if (
        !input.allowInteractiveRecovery
        || !(error instanceof DesktopDaemonLifecycleError)
        || error.code !== "bridge_incompatible"
      ) {
        throw error;
      }
      const decision = await input.prompt({
        baseUrl: error.baseUrl,
        reason: error.code,
        occupant: error.occupant ?? "ling_daemon",
      });
      if (decision === "quit") {
        return "quit";
      }
    }
  }
}
