export type DesktopStartupFailureReason =
  | "child_exited"
  | "start_timeout"
  | "resource_missing"
  | "spawn_failed";

export type DesktopStartupFailureDecision = "retry" | "open-diagnostics" | "quit";

export interface DesktopStartupFailurePrompt {
  readonly baseUrl?: string;
  readonly reason: DesktopStartupFailureReason;
}

export async function resolveDesktopStartupFailure<TPrompt extends DesktopStartupFailurePrompt>(input: {
  readonly prompt: TPrompt;
  readonly decide: (prompt: TPrompt) => Promise<DesktopStartupFailureDecision>;
  readonly openDiagnostics?: () => Promise<void> | void;
}): Promise<"retry" | "quit"> {
  while (true) {
    const decision = await input.decide(input.prompt);
    if (decision === "retry" || decision === "quit") {
      return decision;
    }
    await input.openDiagnostics?.();
  }
}
