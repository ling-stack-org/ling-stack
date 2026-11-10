/**
 * Once this daemon owns a listener, failed initialization must drain its own
 * resources before rejecting. A cleanup failure is not a successful rollback;
 * retain both errors without losing the original startup cause.
 */
export async function initializeDaemonWithCleanup(
  initialize: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await initialize();
  } catch (startupError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "daemon_startup_failed_cleanup_incomplete",
        { cause: startupError },
      );
    }
    throw startupError;
  }
}
