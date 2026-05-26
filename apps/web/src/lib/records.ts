export function removeRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [currentKey, value] of Object.entries(record)) {
    if (currentKey !== key) {
      next[currentKey] = value;
    }
  }
  return next;
}
