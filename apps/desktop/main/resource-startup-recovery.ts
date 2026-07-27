import type { DesktopResourcePaths } from "./resource-paths.js";
import { DesktopResourceResolutionError } from "./resource-paths.js";
import {
  resolveDesktopStartupFailure,
  type DesktopStartupFailureDecision,
  type DesktopStartupFailurePrompt,
} from "./startup-failure-recovery.js";

export async function resolveDesktopResourcesWithStartupRecovery(input: {
  readonly resolveResources: () => Promise<DesktopResourcePaths>;
  readonly allowInteractiveRecovery: boolean;
  readonly prompt: (prompt: DesktopStartupFailurePrompt) => Promise<DesktopStartupFailureDecision>;
  readonly openDiagnostics?: () => Promise<void> | void;
}): Promise<DesktopResourcePaths | undefined> {
  while (true) {
    try {
      return await input.resolveResources();
    } catch (error) {
      if (!input.allowInteractiveRecovery || !(error instanceof DesktopResourceResolutionError)) {
        throw error;
      }
      const decision = await resolveDesktopStartupFailure({
        prompt: { reason: "resource_missing" },
        decide: input.prompt,
        openDiagnostics: input.openDiagnostics,
      });
      if (decision === "quit") {
        return undefined;
      }
    }
  }
}
