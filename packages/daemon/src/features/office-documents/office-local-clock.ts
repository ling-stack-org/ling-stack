/**
 * Ordered local observation time. A wall-clock correction must not make
 * successful acquisition or the original descriptor's close fail validation.
 * This is a Host audit timestamp, not a rewritten native syscall result.
 */
export function officeObservationTime(notBefore?: string): string {
  const sampled = new Date().toISOString();
  return notBefore && sampled < notBefore ? notBefore : sampled;
}
