import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";
import tls from "node:tls";
import { createA11EphemeralTlsFixture } from "./a11-ephemeral-tls-fixture.mjs";

const DOCUMENT_ADDRESSES = new Set(["203.0.113.10", "198.51.100.9", "2001:db8::10", "2001:db8::20"]);
let activeFixture = false;

/**
 * Test-only real-socket fixture. Record the destination at native connect before
 * mapping an explicitly audited documentation address to the owned listener.
 * It never substitutes fetch, a dispatcher, a Response or Host exchange facts.
 * Run in a dedicated child: builtin hooks are process-global, not concurrent.
 */
export async function createA11PublicHttpNetworkFixture(t, { secure = false, family = 4, onRequest } = {}) {
  assert.equal(activeFixture, false, "A11 network fixtures must not overlap in one process");
  assert.ok(family === 4 || family === 6, "A11 fixture family must be 4 or 6");
  assert.ok(onRequest === undefined || typeof onRequest === "function");
  activeFixture = true;
  const hostname = "preview.a11.test";
  const listenerHost = family === 6 ? "::1" : "127.0.0.1";
  const requests = [], connects = [], dnsLookups = [], serverNames = [], tlsConnections = [];
  const apiPorts = new Set(), sockets = new Set(), pendingDns = new Set();
  let answers = Object.freeze([family === 6 ? "2001:db8::10" : "203.0.113.10"]);
  let dnsFailure, dnsStalled = false;
  const tlsMaterial = secure ? createA11EphemeralTlsFixture() : undefined;
  const accept = (request, response) => {
    const observation = Object.freeze({ method: request.method, path: request.url, host: request.headers.host });
    requests.push(observation);
    try {
      if (onRequest) {
        const result = onRequest(request, response, observation);
        if (result && typeof result.then === "function") void result.catch(error => response.destroy(error));
      } else {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, transport: "actual-owned-native-socket" }));
      }
    } catch (error) { response.destroy(error); }
  };
  const server = secure ? createTlsServer({
    key: tlsMaterial.key.export({ type: "pkcs8", format: "pem" }), cert: tlsMaterial.cert,
  }, accept) : createServer(accept);
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  if (secure) server.on("secureConnection", socket => serverNames.push(socket.servername));
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening);
      server.listen({ port: 0, host: listenerHost, ...(family === 6 ? { ipv6Only: true } : {}) });
    });
  } catch (cause) {
    activeFixture = false;
    throw new Error(family === 6 ? `A11_IPV6_BLOCKED: owned ::1 listener unavailable (${cause?.code ?? "unknown"})`
      : "A11 owned IPv4 listener unavailable", { cause });
  }
  const port = server.address().port;
  const originalLookup = dns.lookup, originalPromiseLookup = dnsPromises.lookup, originalTlsConnect = tls.connect;
  const tcpPrototype = process.binding("tcp_wrap").TCP.prototype;
  const originalConnect = tcpPrototype.connect, originalConnect6 = tcpPrototype.connect6;
  let closed = false, closing;
  function resolveFixture(name, kind, options) {
    dnsLookups.push(Object.freeze({ hostname: name, kind, all: options?.all === true }));
    if (name !== hostname) throw Object.assign(new Error("A11 fixture blocks unowned DNS hostname"), { code: "ENOTFOUND" });
    if (dnsFailure) throw dnsFailure;
    if (dnsStalled) return new Promise((resolve, reject) => { pendingDns.add({ resolve, reject }); });
    return answers.map(address => ({ address, family: isIP(address) }));
  }
  function settlePendingDns(error) {
    const pending = [...pendingDns];
    pendingDns.clear();
    for (const entry of pending) {
      if (error) entry.reject(error);
      else entry.resolve(answers.map(address => ({ address, family: isIP(address) })));
    }
    return pending.length;
  }
  function releaseDnsStall(values = answers) {
    assert.equal(closed, false);
    assert.ok(Array.isArray(values) && values.every(value => typeof value === "string"));
    answers = Object.freeze([...values]); dnsFailure = undefined; dnsStalled = false;
    return settlePendingDns();
  }
  dnsPromises.lookup = async (name, options) => {
    const values = await resolveFixture(name, "approval", options);
    return options?.all ? values : values[0];
  };
  dns.lookup = (name, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    // Server.listen asks lookup even for its literal binding address. This is
    // an exact literal identity, not permission to resolve a new hostname or
    // connect anywhere: TCP still requires an explicitly allowed API port.
    if (name === "127.0.0.1") {
      dnsLookups.push(Object.freeze({ hostname: name, kind: "api_literal", all: options?.all === true }));
      queueMicrotask(() => options?.all ? callback(null, [{ address: name, family: 4 }]) : callback(null, name, 4));
      return;
    }
    try {
      Promise.resolve(resolveFixture(name, "sender", options)).then(values =>
        options?.all ? callback(null, values) : callback(null, values[0]?.address, values[0]?.family), error => callback(error));
    } catch (error) { queueMicrotask(() => callback(error)); }
  };
  function assertDestination(address, targetPort, actualFamily) {
    const api = actualFamily === 4 && address === "127.0.0.1" && apiPorts.has(targetPort);
    const audited = targetPort === port && DOCUMENT_ADDRESSES.has(address) && answers.includes(address)
      && isIP(address) === actualFamily && actualFamily === family;
    const observation = Object.freeze({ address, family: actualFamily, port: targetPort, kind: api ? "api" : "upstream", allowed: api || audited });
    connects.push(observation);
    assert.ok(api || audited, `A11 fixture blocks unowned socket: ${JSON.stringify(observation)}`);
    return api;
  }
  tcpPrototype.connect = function (request, address, targetPort, ...rest) {
    const api = assertDestination(address, targetPort, 4);
    return originalConnect.call(this, request, api ? address : "127.0.0.1", targetPort, ...rest);
  };
  tcpPrototype.connect6 = function (request, address, targetPort, ...rest) {
    assertDestination(address, targetPort, 6);
    return originalConnect6.call(this, request, "::1", targetPort, ...rest);
  };
  tls.connect = function (options, ...rest) {
    assert.ok(secure && options && typeof options === "object", "A11 fixture blocks unowned TLS sender");
    assert.equal(options.servername, hostname, "TLS SNI must remain the original hostname");
    assert.notEqual(options.rejectUnauthorized, false, "TLS certificate verification must remain enabled");
    assert.equal(options.checkServerIdentity, undefined, "fixture must not replace hostname verification");
    const socket = originalTlsConnect.call(this, { ...options, ca: tlsMaterial.cert }, ...rest);
    socket.once("secureConnect", () => tlsConnections.push(Object.freeze({
      servername: options.servername, authorized: socket.authorized, authorizationError: socket.authorizationError ?? null,
    })));
    return socket;
  };
  syncBuiltinESMExports();
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      dnsStalled = false;
      settlePendingDns(new Error("A11 fixture closed before its owned DNS lookup completed"));
      dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; tls.connect = originalTlsConnect;
      tcpPrototype.connect = originalConnect; tcpPrototype.connect6 = originalConnect6;
      syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      finally { activeFixture = false; }
    })();
    return closing;
  }
  t.after(close);
  return Object.freeze({
    baseUrl: `${secure ? "https" : "http"}://${hostname}:${port}`,
    hostname, port, family, requests, connects, dnsLookups, serverNames, tlsConnections,
    get pendingDnsLookups() { return pendingDns.size; },
    setDnsAnswers(values) { releaseDnsStall(values); },
    setDnsFailure(error) {
      assert.equal(closed, false); assert.ok(error instanceof Error);
      dnsFailure = error; dnsStalled = false; settlePendingDns(error);
    },
    setDnsStall() { assert.equal(closed, false); dnsFailure = undefined; dnsStalled = true; },
    releaseDnsStall,
    allowApiPort(value) {
      assert.equal(closed, false);
      assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= 65_535 && value !== port);
      apiPorts.add(value);
    },
    close,
  });
}
