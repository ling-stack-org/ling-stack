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
  closing: boolean;
  closePromise?: Promise<void>;
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
        closing: false,
        connecting,
      };
      entry = next;
      this.entries.set(key, entry);
      void connecting.then(
        (client) => {
          if (entry?.key === key && !entry.closing) {
            entry.client = client;
          } else {
            void client.close();
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
    entry.controller.abort();
    this.entries.delete(entry.key);
    entry.closePromise = (async () => {
      const client = entry.client ?? await Promise.race([
        entry.connecting.catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.closeTimeoutMs)),
      ]);
      if (!client) return;
      // Existing operations are cancelled by the shared AbortSignal. Do not
      // wait forever on a broken provider; close exactly once after a bound.
      await Promise.race([
        Promise.resolve(client.close()),
        new Promise<void>((resolve) => setTimeout(resolve, this.closeTimeoutMs)),
      ]);
    })();
    return entry.closePromise;
  }
}
