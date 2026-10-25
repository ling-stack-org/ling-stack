/** A rejected stop is not a crash or permission for Desktop to restart the Host. */
export function createDaemonSignalShutdown(input: {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly onBlocked: (error: unknown) => void;
}): () => Promise<void> {
  let work: Promise<void> | undefined;
  return () => {
    if (work) return work;
    // Install single-flight before invoking the original callback, including a
    // synchronous throw/reentrant signal. The failure handler retains the Host;
    // it must never manufacture a successful close or release its resources.
    let resolve!: () => void;
    work = new Promise<void>(done => { resolve = done; });
    const blocked = (error: unknown): void => {
      // A failed diagnostic cannot turn refused stop proof into a process crash.
      try { input.onBlocked(error); } catch { /* Keep the failed lifecycle retained. */ }
      resolve();
    };
    try {
      void input.stop().then(() => { input.exit(0); resolve(); }, blocked);
    } catch (error) { blocked(error); }
    return work;
  };
}
