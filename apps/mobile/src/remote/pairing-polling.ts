export interface PairingPollingOptions<T> {
  readonly expiresAt: string;
  readonly submit: () => Promise<T | undefined>;
  readonly isActive: () => boolean;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly intervalMs?: number;
  readonly onTransientError?: (error: unknown) => void;
}

export async function pollForPairingAcceptance<T>(
  options: PairingPollingOptions<T>,
): Promise<T | undefined> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const intervalMs = options.intervalMs ?? 1_500;

  while (options.isActive()) {
    if (Date.parse(options.expiresAt) < now()) {
      throw new Error("pairing_expired");
    }
    await wait(intervalMs);
    if (!options.isActive()) {
      return undefined;
    }
    try {
      const accepted = await options.submit();
      if (accepted) {
        return accepted;
      }
    } catch (error) {
      if (!isTransientPairingPollError(error)) {
        throw error;
      }
      options.onTransientError?.(error);
    }
  }
  return undefined;
}

export function isTransientPairingPollError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:network request failed|failed to fetch|fetch failed|load failed|offline|timed?\s*out|connection (?:lost|reset|closed)|temporar(?:y|ily) unavailable)/iu.test(message);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
