/** A descriptor failure must not bypass the daemon's existing remaining drain. */
export async function shutdownAfterNativeBroker(
  closeBroker: () => Promise<void>,
  remainingShutdown: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try { await closeBroker(); }
  catch (error) { failures.push(error); }
  try { await remainingShutdown(); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "native_broker_and_daemon_shutdown_failed");
}
