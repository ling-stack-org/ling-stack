// Research only. Nothing in the Daemon imports this module.
const identityFields = ["workspaceId", "serverId", "configRevision", "credentialGeneration", "activationEpoch"];

function identity(scope) {
  if (!scope || Object.keys(scope).length !== identityFields.length || identityFields.some(key =>
    typeof scope[key] !== "string" || !scope[key] || scope[key].length > 256)) throw new Error("invalid_connection_identity");
  return { namespace: JSON.stringify([scope.workspaceId, scope.serverId]), key: JSON.stringify(identityFields.map(key => scope[key])) };
}

/**
 * A bounded transport-lifetime experiment, not an admission/authorization cache.
 * Credentials are resolved by the connector, never supplied as identity values.
 * Each invocation must independently admit and validate its result.
 */
export class ExperimentalGenerationPool {
  #active = new Map();
  #entries = new Set();
  #accepting = true;
  #connect;
  #limit;
  #idleMs;
  #closeErrors = 0;

  constructor({ enabled = false, connect, maxConnections = 8, idleMs = 1000 } = {}) {
    if (!enabled) throw new Error("mcp_reuse_experiment_disabled");
    if (typeof connect !== "function" || !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 32 ||
      !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 60_000) throw new Error("invalid_pool_configuration");
    this.#connect = connect;
    this.#limit = maxConnections;
    this.#idleMs = idleMs;
  }

  async run(scope, { admit, assertCurrent, signal }, operation) {
    if (typeof admit !== "function" || typeof assertCurrent !== "function" || typeof operation !== "function") throw new Error("per_call_guards_required");
    signal?.throwIfAborted();
    admit();
    assertCurrent();
    if (!this.#accepting) throw new Error("pool_shutting_down");
    const { namespace, key } = identity(scope);
    let entry = this.#active.get(namespace);
    if (entry?.key !== key) {
      if (entry) this.#retire(entry);
      if (this.#entries.size >= this.#limit) throw new Error("pool_capacity_exceeded");
      entry = { namespace, key, users: 0, retired: false, timer: undefined, closing: undefined, client: undefined };
      this.#entries.add(entry);
      this.#active.set(namespace, entry);
      const created = entry;
      // Publish one promise before connection work starts. Configuration changes
      // retire this generation; completing its handshake cannot replace a new one.
      created.ready = Promise.resolve().then(() => this.#connect(Object.freeze({ ...scope }))).then(client => {
        created.client = client;
        return client;
      }).catch(error => {
        this.#retire(created);
        throw error;
      });
    }
    clearTimeout(entry.timer);
    entry.users += 1;
    try {
      const client = await entry.ready;
      signal?.throwIfAborted();
      assertCurrent();
      if (entry.retired || !this.#accepting) throw new Error("connection_generation_stale");
      // Cancellation is per SDK request; it never closes a shared transport.
      const result = await operation(client, signal);
      signal?.throwIfAborted();
      assertCurrent();
      if (entry.retired || !this.#accepting) throw new Error("connection_generation_stale");
      return result;
    } finally {
      entry.users -= 1;
      if (entry.users === 0) {
        if (entry.retired) void this.#close(entry);
        else {
          entry.timer = setTimeout(() => this.#retire(entry), this.#idleMs);
          entry.timer.unref?.();
        }
      }
    }
  }

  invalidate(workspaceId, serverId) {
    const entry = this.#active.get(JSON.stringify([workspaceId, serverId]));
    if (entry) this.#retire(entry);
  }

  #retire(entry) {
    entry.retired = true;
    clearTimeout(entry.timer);
    if (this.#active.get(entry.namespace) === entry) this.#active.delete(entry.namespace);
    if (entry.users === 0) void this.#close(entry);
  }

  #close(entry) {
    return entry.closing ??= (async () => {
      try {
        // A rejected handshake owns no connected client to close.
        const client = entry.client ?? await entry.ready.catch(() => undefined);
        await client?.close();
      } catch {
        // A close failure is reported by shutdown, never called clean drainage.
        this.#closeErrors += 1;
      } finally {
        this.#entries.delete(entry);
      }
    })();
  }

  async shutdown({ drainMs = 1000 } = {}) {
    if (!Number.isSafeInteger(drainMs) || drainMs < 0 || drainMs > 10_000) throw new Error("invalid_drain_budget");
    this.#accepting = false;
    const entries = [...this.#entries];
    entries.forEach(entry => this.#retire(entry));
    const deadline = performance.now() + drainMs;
    while (entries.some(entry => entry.users > 0) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const forced = entries.filter(entry => entry.users > 0).length;
    // A finite close budget does not prove a stalled connector/process stopped.
    let timer;
    const closed = await Promise.race([
      Promise.all(entries.map(entry => this.#close(entry))).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]).finally(() => clearTimeout(timer));
    return { drained: forced === 0 && closed && this.#closeErrors === 0, forced, closed, closeErrors: this.#closeErrors };
  }
}
