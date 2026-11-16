export interface RunReadyInfo {
  readonly queued?: boolean;
}

export function notifyRunReady(
  callback: ((runId: string, info?: RunReadyInfo) => void) | undefined,
  runId: string,
  info?: RunReadyInfo,
): void {
  try {
    callback?.(runId, info);
  } catch {
    // Durable run state and transport readiness do not depend on auxiliary link updates.
  }
}
