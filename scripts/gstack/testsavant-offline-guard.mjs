import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
// Preloaded and compiled copies share one per-process counter and installation.
const key = Symbol.for("ling.testsavant.network-denial.v1");
const state = globalThis[key] ??= { attempts: 0, installed: false };
const deny = () => { state.attempts++; throw new Error("testsavant_network_forbidden"); };
if (!state.installed) {
globalThis.fetch = deny; globalThis.WebSocket = deny;
for (const [name, methods] of [["http", ["request", "get"]], ["https", ["request", "get"]],
  ["net", ["connect", "createConnection"]], ["tls", ["connect"]],
  ["dgram", ["createSocket"]]]) {
  const module = require(`node:${name}`);
  for (const method of methods) module[method] = deny;
}
for (const module of [require("node:dns"), require("node:dns/promises")]) {
  const resolver = module.Resolver;
  for (const name of Object.getOwnPropertyNames(resolver.prototype)) {
    if (/^(?:resolve|reverse)/.test(name)) resolver.prototype[name] = deny;
  }
  for (const name of Object.keys(module)) {
    if (/^(?:lookup|resolve|reverse)/.test(name) && typeof module[name] === "function") module[name] = deny;
  }
  module.Resolver = class { constructor() { deny(); } };
}
require("node:net").Socket.prototype.connect = deny;
require("node:tls").TLSSocket.prototype.connect = deny;
require("node:http2").connect = deny;
syncBuiltinESMExports();
state.installed = true;
}
export const networkAttempts = () => state.attempts;

// HTTP acceptance may listen on loopback. Resolve literal addresses locally;
// no DNS service, outgoing socket or HTTP client is re-enabled.
export function permitLoopbackListenerLookup() {
  require("node:dns").lookup = (hostname, options, callback) => {
    if (!["127.0.0.1", "::1"].includes(hostname)) return deny();
    if (typeof options === "function") { callback = options; options = {}; }
    const family = hostname === "::1" ? 6 : 4;
    queueMicrotask(() => options?.all ? callback(null, [{ address: hostname, family }]) : callback(null, hostname, family));
  };
  syncBuiltinESMExports();
}
