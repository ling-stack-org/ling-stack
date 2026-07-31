/**
 * Resolves as soon as a daemon-owned run has a durable run id. The run itself
 * remains detached from the originating HTTP or Remote Gateway connection.
 */
export async function startDetachedRunAndResolveReady(
  startRun: (onRunReady: (runId: string) => void) => Promise<string | undefined>,
): Promise<string | undefined> {
  let settled = false;
  return await new Promise<string | undefined>((resolve) => {
    const settle = (runId: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(runId);
    };
    void startRun((runId) => settle(runId))
      .then((runId) => settle(runId))
      .catch(() => settle(undefined));
  });
}
