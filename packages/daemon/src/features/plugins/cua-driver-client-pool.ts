import type { DesktopCuaDriverLease } from "@ling-stack/contracts";
import { cuaDriverLeasePoolKey } from "./cua-driver-lease.js";

export interface CuaDriverPooledClient {
  readonly close: () => Promise<void> | void;
}

export interface CuaDriverPooledClientFactory<TClient extends CuaDriverPooledClient = CuaDriverPooledClient> {
  readonly connect: (lease: DesktopCuaDriverLease, signal: AbortSignal) => Promise<TClient>;
}

export interface CuaDriverPoolHandle<TClient extends CuaDriverPooledClient> {
  readonly key: string;
  readonly client: TClient;
  readonly release: () => void;
}

interface PoolEntry<TClient extends CuaDriverPooledClient> {
  readonly key: string;
  readonly lease: DesktopCuaDriverLease;
  readonly controller: AbortController;
  readonly connecting: Promise<TClient>;
  client?: TClient;
  activeOperations: number;
  readonly drainWaiters: Set<() => void>;
  closing: boolean;
  closePromise?: Promise<void>;
  clientClosePromise?: Promise<void>;
}

/**
 * One initialized client per Desktop lease generation. The class is generic on
 * purpose: PR4 can adapt its stdio MCP proxy without making the daemon depend on
 * a provisional endpoint implementation.
 */
export class CuaDriverClientPool<TClient extends CuaDriverPooledClient = CuaDriverPooledClient> {
  private readonly entries = new Map<string, PoolEntry<TClient>>();
  private readonly factory: CuaDriverPooledClientFactory<TClient>;
  private readonly closeTimeoutMs: number;

  constructor(input: {
    readonly factory: CuaDriverPooledClientFactory<TClient>;
    readonly closeTimeoutMs?: number;
  }) {
    this.factory = input.factory;
    this.closeTimeoutMs = input.closeTimeoutMs ?? 1_000;
  }

  async acquire(lease: DesktopCuaDriverLease): Promise<CuaDriverPoolHandle<TClient>> {
    const key = cuaDriverLeasePoolKey(lease);
    let entry = this.entries.get(key);
    if (!entry || entry.closing) {
      const controller = new AbortController();
      const connecting = this.factory.connect(lease, controller.signal);
      const next: PoolEntry<TClient> = {
        key,
        lease,
        controller,
        activeOperations: 0,
        drainWaiters: new Set(),
        closing: false,
        connecting,
      };
      entry = next;
      this.entries.set(key, entry);
      void connecting.then(
        (client) => {
          entry!.client = client;
          if (entry!.closing || this.entries.get(key) !== entry) {
            void this.closeClientOnce(entry!, client);
          }
        },
        () => {
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
        },
      );
    }

    const client = await entry.connecting;
    if (entry.closing || this.entries.get(key) !== entry) {
      throw new Error("cua_driver_lease_client_stale");
    }
    entry.client = client;
    entry.activeOperations += 1;
    let released = false;
    return {
      key,
      client,
      release: () => {
        if (released) return;
        released = true;
        entry!.activeOperations = Math.max(0, entry!.activeOperations - 1);
        if (entry!.activeOperations === 0) {
          for (const resolve of entry!.drainWaiters) resolve();
          entry!.drainWaiters.clear();
        }
      },
    };
  }

  async closeStale(currentLease: DesktopCuaDriverLease | undefined): Promise<void> {
    const currentKey = currentLease ? cuaDriverLeasePoolKey(currentLease) : undefined;
    const closing = [...this.entries.values()]
      .filter((entry) => entry.key !== currentKey)
      .map((entry) => this.closeEntry(entry));
    await Promise.all(closing);
  }

  async closeLease(lease: DesktopCuaDriverLease): Promise<void> {
    const entry = this.entries.get(cuaDriverLeasePoolKey(lease));
    if (entry) await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }

  get size(): number {
    return this.entries.size;
  }

  private async closeEntry(entry: PoolEntry<TClient>): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    entry.closing = true;
    this.entries.delete(entry.key);
    entry.closePromise = (async () => {
      await this.waitForActiveOperations(entry);
      entry.controller.abort();
      const client = entry.client ?? await settleWithin(entry.connecting, this.closeTimeoutMs);
      if (!client) return;
      // The connect completion handler also reaches this helper when a client
      // materializes after the bounded wait. Memoization keeps close exactly-once.
      await settleWithin(this.closeClientOnce(entry, client), this.closeTimeoutMs);
    })();
    return entry.closePromise;
  }

  private async waitForActiveOperations(entry: PoolEntry<TClient>): Promise<void> {
    if (entry.activeOperations === 0) return;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      entry.drainWaiters.add(resolve);
    });
    await settleWithin(drained, this.closeTimeoutMs);
    entry.drainWaiters.delete(resolveDrain);
  }

  private closeClientOnce(entry: PoolEntry<TClient>, client: TClient): Promise<void> {
    if (!entry.clientClosePromise) {
      entry.clientClosePromise = Promise.resolve()
        .then(() => client.close())
        .then(() => undefined, () => undefined);
    }
    return entry.clientClosePromise;
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
