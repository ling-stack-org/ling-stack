/** SQLite keyset timestamps must retain chronological order under TEXT comparison. */
export function assertRecoveryDiscoveryTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error(`Recovery discovery ${label} must be canonical UTC.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Recovery discovery ${label} must be canonical UTC.`);
  }
}

/** Reject ambiguous or unbounded discovery identities before preparing a query. */
export function assertRecoveryDiscoveryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > 1024 || value.includes("\0")) {
    throw new Error("Invalid recovery discovery cursor id.");
  }
}
