import type { HostOperationSource, RunStore, HostAttemptEffectObservation } from "@ling-stack/core";

/** Observation failure withholds durable proof; it never changes tool execution policy. */
export function observeHostAttemptCompletion(store: Pick<RunStore, "trackHostAttemptCompletion" | "releaseHostAttemptResources">,
  source: HostOperationSource, lifetime: Promise<unknown>, verifyEffectCoverage?: () => HostAttemptEffectObservation,
  onDurableCleanup?: () => void): Promise<void> {
  const unavailable = (): void => {
    console.warn("host_attempt_completion_unavailable: durable local drain remains unverified");
  };
  try {
    return store.trackHostAttemptCompletion(source, lifetime, verifyEffectCoverage).then(async fact => {
      for (let attempt = 0; ; attempt++) {
        try {
          store.releaseHostAttemptResources(fact.source, new Date().toISOString());
          if (fact.effectCoverage) onDurableCleanup?.();
          return;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }).catch(unavailable);
  } catch {
    unavailable();
    return lifetime.then(() => undefined, unavailable);
  }
}
