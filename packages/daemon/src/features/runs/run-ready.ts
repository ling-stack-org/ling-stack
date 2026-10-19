export function notifyRunReady(callback: ((runId: string) => void) | undefined, runId: string): void {
  try {
    callback?.(runId);
  } catch {
    // Durable run state and transport readiness do not depend on auxiliary link updates.
  }
}
