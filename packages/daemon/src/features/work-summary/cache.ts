/** Bounded single-flight cache. Failed reads never become successful zero-valued snapshots. */
export class SummaryCache<T> {
  private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 128) {}
  get(key: string, read: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expires > Date.now()) return current.value;
    const entry = { expires: Number.POSITIVE_INFINITY, value: Promise.resolve().then(read) };
    this.entries.set(key, entry);
    entry.value.then(() => { entry.expires = Date.now() + this.ttlMs; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return entry.value;
  }
}

export async function mapSummaryItems<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]!);
    }
  }));
  return results;
}
