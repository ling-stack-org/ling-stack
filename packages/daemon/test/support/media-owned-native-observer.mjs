/**
 * Test-only observer installed before native-http-transport captures fetch.
 * Each rule claims one exact owned-upstream request. A non-cooperative rule
 * deliberately ignores its signal, but still uses the original native fetch,
 * original Response/body and original receipt producer. It is not the default
 * product sender, a synthetic Response, or a source of exchange authority.
 */
export function installOwnedMediaNativeObserver() {
  const originalFetch = globalThis.fetch;
  const rules = new Set();
  const installedFetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const rule = [...rules].find(candidate => !candidate.record && candidate.matches(url, input, init));
    if (!rule) return Reflect.apply(originalFetch, globalThis, [input, init]);
    const record = { url, method: input instanceof Request ? input.method : init?.method ?? "GET",
      ignoreSignal: rule.ignoreSignal, signal: input instanceof Request ? input.signal : init?.signal,
      aborts: 0, fetchSettled: 0, fetchRejected: 0, bodySettled: 0, bodyRejected: 0,
      completedEof: false, response: undefined, errors: [], restorations: [] };
    rule.record = record;
    const onAbort = () => { record.aborts++; };
    record.signal?.addEventListener("abort", onAbort, { once: true });
    record.restorations.push(() => record.signal?.removeEventListener("abort", onAbort));
    // Only this explicitly selected test request ignores cancellation. All wire
    // URL/method/headers/body bytes still come from the original actual Request.
    const pending = Reflect.apply(originalFetch, globalThis,
      [input, rule.ignoreSignal ? { ...init, signal: null } : init]);
    // Observe separately and return the exact original native Promise.
    pending.then(response => {
      record.fetchSettled++;
      record.response = response;
      try { observeBody(response, record); } catch (error) { record.errors.push(error); }
    }, () => { record.fetchSettled++; record.fetchRejected++; });
    return pending;
  };
  globalThis.fetch = installedFetch;
  return {
    register({ matches, ignoreSignal = false }) {
      const rule = { matches, ignoreSignal, record: undefined };
      rules.add(rule);
      return {
        get record() { return rule.record; },
        close() {
          rules.delete(rule);
          for (const restore of rule.record?.restorations.splice(0).reverse() ?? []) restore();
        },
      };
    },
    restore() {
      for (const rule of rules) for (const restore of rule.record?.restorations.splice(0).reverse() ?? []) restore();
      rules.clear();
      if (globalThis.fetch !== installedFetch) throw new Error("owned_media_native_observer_replaced");
      globalThis.fetch = originalFetch;
    },
  };
}

/** Transparent observations retain the actual reader, this/args and Promise. */
function observeBody(response, record) {
  if (!response.body) { record.bodySettled++; record.completedEof = true; return; }
  const body = response.body, descriptor = Object.getOwnPropertyDescriptor(body, "getReader");
  const originalGetReader = body.getReader;
  Object.defineProperty(body, "getReader", { configurable: true, writable: true,
    value: function (...args) {
      const reader = Reflect.apply(originalGetReader, this, args);
      const readDescriptor = Object.getOwnPropertyDescriptor(reader, "read"), originalRead = reader.read;
      let settled = false;
      Object.defineProperty(reader, "read", { configurable: true, writable: true,
        value: function (...readArgs) {
          const pending = Reflect.apply(originalRead, this, readArgs);
          pending.then(result => {
            if (!settled && result.done) { settled = true; record.bodySettled++; record.completedEof = true; }
          }, () => {
            if (!settled) { settled = true; record.bodySettled++; record.bodyRejected++; }
          });
          return pending;
        },
      });
      record.restorations.push(() => restoreProperty(reader, "read", readDescriptor));
      return reader;
    },
  });
  record.restorations.push(() => restoreProperty(body, "getReader", descriptor));
}

function restoreProperty(target, key, descriptor) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}
