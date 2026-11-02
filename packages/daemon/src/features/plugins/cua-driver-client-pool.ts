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
  /** Aborted on physical retirement, after Host drain when shutdown has begun. */
  readonly signal: AbortSignal;
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
  closeAuthorized: boolean;
  closePromise?: Promise<void>;
  physicalClosePromise?: Promise<void>;
  clientClosePromise?: Promise<void>;
}

/**
 * One initialized client per Desktop lease generation. The class is generic on
 * purpose: PR4 can adapt its stdio MCP proxy without making the daemon depend on
 * a provisional endpoint implementation.
 */
export class CuaDriverClientPool<TClient extends CuaDriverPooledClient = CuaDriverPooledClient> {
  private readonly entries = new Map<string, PoolEntry<TClient>>();
  private readonly retiringEntries = new Set<PoolEntry<TClient>>();
  private readonly shutdownWaiters = new Set<() => void>();
  private lifecycle: "open" | "draining" | "closed" = "open";
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
    this.assertAdmissionOpen();
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
        closeAuthorized: false,
        connecting,
      };
      entry = next;
      this.entries.set(key, entry);
      void connecting.then(
        (client) => {
          entry!.client = client;
          if (entry!.closeAuthorized) {
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
    this.assertAdmissionOpen();
    if (entry.closing || this.entries.get(key) !== entry) {
      throw new Error("cua_driver_lease_client_stale");
    }
    entry.client = client;
    entry.activeOperations += 1;
    let released = false;
    return {
      key,
      client,
      signal: entry.controller.signal,
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

  /**
   * Freeze admission synchronously without tearing down accepted Host work.
   * Retirement still fences the generation, but its physical close is deferred.
   */
  beginShutdown(): void {
    if (this.lifecycle !== "open") return;
    this.lifecycle = "draining";
    for (const resolve of this.shutdownWaiters) resolve();
    this.shutdownWaiters.clear();
  }

  /** afterHostDrain is only used after the owning Host has proved its drain. */
  async closeAll(options: { readonly afterHostDrain?: boolean } = {}): Promise<void> {
    if (options.afterHostDrain) {
      this.beginShutdown();
      this.lifecycle = "closed";
      // A retirement removes its entry from the live map before awaiting an
      // operation. Keep those entries reachable until physical cleanup.
      const entries = new Set([...this.entries.values(), ...this.retiringEntries]);
      await Promise.all([...entries].map((entry) => {
        this.retireEntry(entry);
        return this.closeEntryNow(entry, true);
      }));
      return;
    }
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }

  get size(): number {
    return this.entries.size;
  }

  private async closeEntry(entry: PoolEntry<TClient>): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    this.retireEntry(entry);
    entry.closePromise = (async () => {
      await this.waitForActiveOperations(entry);
      // Returning here is intentional: activation/tool finalizers may await
      // retirement while the Host awaits them. Final cleanup cannot own that
      // wait or shutdown would deadlock.
      if (this.lifecycle === "draining") return;
      await this.closeEntryNow(entry);
    })();
    return entry.closePromise;
  }

  private retireEntry(entry: PoolEntry<TClient>): void {
    entry.closing = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.retiringEntries.add(entry);
  }

  private closeEntryNow(entry: PoolEntry<TClient>, waitForActive = false): Promise<void> {
    if (entry.physicalClosePromise) return entry.physicalClosePromise;
    entry.physicalClosePromise = (async () => {
      if (waitForActive) await this.waitForActiveOperations(entry, true);
      entry.closeAuthorized = true;
      entry.controller.abort();
      const client = entry.client ?? await settleWithin(entry.connecting, this.closeTimeoutMs);
      if (!client) return;
      // The connect completion handler also reaches this helper when a client
      // materializes after the bounded wait. Memoization keeps close exactly-once.
      await settleWithin(this.closeClientOnce(entry, client), this.closeTimeoutMs);
    })().finally(() => {
      this.retiringEntries.delete(entry);
    });
    return entry.physicalClosePromise;
  }

  private async waitForActiveOperations(entry: PoolEntry<TClient>, physicalClose = false): Promise<void> {
    if (entry.activeOperations === 0 || (!physicalClose && this.lifecycle !== "open")) return;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      entry.drainWaiters.add(resolve);
      if (!physicalClose) this.shutdownWaiters.add(resolve);
    });
    await settleWithin(drained, this.closeTimeoutMs);
    entry.drainWaiters.delete(resolveDrain);
    this.shutdownWaiters.delete(resolveDrain);
  }

  private assertAdmissionOpen(): void {
    if (this.lifecycle !== "open") throw new Error("cua_driver_client_pool_shutting_down");
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
