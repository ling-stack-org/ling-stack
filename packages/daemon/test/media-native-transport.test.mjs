import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sha = value => createHash("sha256").update(value).digest("hex");
const isRedirectError = error => /redirect/i.test(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`);
const A11_PUBLIC_ADDRESS = "203.0.113.10";
const A11_PUBLIC_FALLBACK_ADDRESS = "198.51.100.9";
const A11_PRIVATE_ADDRESS = "127.0.0.2";
// Dedicated offline CA/server key. Only this fixture trusts it; hostname and SNI
// verification remain enabled, including the wrong-host negative case.
const A11_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB
AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA
///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV
AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg
9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A
AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgB8LxxCgGmQGK
Sijxbge84wY/5houYaHWTjNlcTEkBAShRANCAATKmQfF+1v3+ZEkhT1KbGrJuNli
BcvJAHThTW9/StBB4QmW/jj5qVaki1Qw23hpDvzicO1LRidbKh3dg6BXIN7Z
-----END PRIVATE KEY-----`;
const A11_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIICWDCCAf2gAwIBAgIJAK/q8MpkHvU2MAoGCCqGSM49BAMCMCExHzAdBgNVBAMM
FkExMSBvZmZsaW5lIGZpeHR1cmUgQ0EwHhcNMjYxMDEyMTcwNzI2WhcNMzYxMDA5
MTcwNzI2WjAhMR8wHQYDVQQDDBZBMTEgb2ZmbGluZSBmaXh0dXJlIENBMIIBSzCC
AQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAA
AAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA////////////
///8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wST
amZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP
40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA////////
//+85vqtpxeehPO5ysL8YyVRAgEBA0IABMqZB8X7W/f5kSSFPUpsasm42WIFy8kA
dOFNb39K0EHhCZb+OPmpVqSLVDDbeGkO/OJw7UtGJ1sqHd2DoFcg3tmjKjAoMBUG
A1UdEQQOMAyCCiouYTExLnRlc3QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNJADBGAiEAtCb9EAng4FVYeyGNvQcNFfCCG/x3SkcXwg9qrcYgQxwCIQCWNThy
jmoiCcophGzU2z8GOapB8qUU8lc8XyInD9Cl8g==
-----END CERTIFICATE-----`;

/** Child isolation prevents the real-socket fixture hooks leaking to other tests. */
export function runA11SocketCase(caseName) {
  const childEnv = { ...process.env, LING_A11_SOCKET_CASE: caseName };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^A11 fixture child$", import.meta.filename], {
    env: childEnv, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.error, undefined, `${caseName}: ${result.error?.message}`);
  assert.match(result.stdout, new RegExp(`A11 child entered: ${caseName}`), "child must actually run its socket assertions");
  assert.equal(result.status, 0, `${caseName}\n${result.stdout}\n${result.stderr}`);
}

/**
 * Record the final TCP address, not a fake fetch or merely resolver call count.
 * Only the two fixture addresses at our owned port may connect; they are mapped
 * to separate owned loopback servers immediately before the actual native call.
 */
async function a11SocketHarness(t, { secure = false, handler, answers, allowTrustedLoopback = false, forceFirstRefused = false } = {}) {
  const requests = [], attempts = [], dnsCalls = [], serverNames = [];
  const owned = [];
  for (const kind of ["public", "private"]) {
    const accept = (request, response) => {
      requests.push({ kind, host: request.headers.host, route: request.url, auth: request.headers.authorization });
      if (handler) handler(request, response, kind);
      else { response.setHeader("content-type", "text/html"); response.end("<title>A11 pinned</title><main>actual public body</main>"); }
    };
    const instance = secure ? createTlsServer({ key: A11_TLS_KEY, cert: A11_TLS_CERT }, accept) : createServer(accept);
    if (secure) instance.on("secureConnection", socket => serverNames.push(socket.servername));
    instance.listen(0, "127.0.0.1");
    await once(instance, "listening");
    owned.push(instance);
  }
  const port = owned[0].address().port;
  const refusalPort = owned[1].address().port;
  if (forceFirstRefused) await new Promise(resolve => owned[1].close(resolve));
  const originalLookup = dns.lookup, originalPromiseLookup = dnsPromises.lookup, originalTlsConnect = tls.connect;
  const tcpPrototype = process.binding("tcp_wrap").TCP.prototype;
  const originalConnect = tcpPrototype.connect, originalConnect6 = tcpPrototype.connect6;
  const resolve = async hostname => {
    dnsCalls.push({ kind: "approval", hostname });
    return answers ? await answers(hostname, dnsCalls.filter(call => call.kind === "approval").length) : [A11_PUBLIC_ADDRESS];
  };
  dnsPromises.lookup = async (hostname, options) => {
    const addresses = (await resolve(hostname)).map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
    return options?.all ? addresses : addresses[0];
  };
  dns.lookup = (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    dnsCalls.push({ kind: "sender", hostname });
    const address = A11_PRIVATE_ADDRESS;
    queueMicrotask(() => options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4));
  };
  tcpPrototype.connect = function (request, address, targetPort) {
    attempts.push({ address, family: 4, port: targetPort });
    assert.equal(targetPort, port, "offline fixture blocks non-owned port");
    assert.ok(address === A11_PUBLIC_ADDRESS || address === A11_PRIVATE_ADDRESS ||
      (forceFirstRefused && address === A11_PUBLIC_FALLBACK_ADDRESS) ||
      (allowTrustedLoopback && address === "127.0.0.1"), "offline fixture blocks non-owned address");
    if (forceFirstRefused && address === A11_PUBLIC_ADDRESS) return originalConnect.call(this, request, "127.0.0.1", refusalPort);
    const upstream = owned[address === A11_PUBLIC_ADDRESS ? 0 : 1];
    return originalConnect.call(this, request, "127.0.0.1", address === A11_PUBLIC_FALLBACK_ADDRESS ? port : upstream.address().port);
  };
  tcpPrototype.connect6 = function (_request, address, targetPort) {
    attempts.push({ address, family: 6, port: targetPort });
    throw new Error("offline fixture blocks unowned IPv6 socket");
  };
  tls.connect = function (...args) {
    assert.equal(typeof args[0], "object", "fixture expects the verified native connector options");
    assert.notEqual(args[0].rejectUnauthorized, false, "TLS verification must stay enabled");
    return originalTlsConnect.call(this, { ...args[0], ca: A11_TLS_CERT }, ...args.slice(1));
  };
  syncBuiltinESMExports();
  t.after(async () => {
    dns.lookup = originalLookup; dnsPromises.lookup = originalPromiseLookup; tls.connect = originalTlsConnect;
    tcpPrototype.connect = originalConnect; tcpPrototype.connect6 = originalConnect6;
    syncBuiltinESMExports();
    for (const instance of owned) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  });
  return {
    port, requests, attempts, dnsCalls, serverNames, resolve,
    url: (host, route = "/docs") => `${secure ? "https" : "http"}://${host}:${port}${route}`,
    assertPinned() {
      assert.ok(attempts.length > 0, "must observe a real native TCP connection");
      assert.ok(attempts.every(attempt => attempt.address === A11_PUBLIC_ADDRESS ||
        (forceFirstRefused && attempt.address === A11_PUBLIC_FALLBACK_ADDRESS)), `actual connect not pinned: ${JSON.stringify(attempts)}`);
      assert.equal(dnsCalls.filter(call => call.kind === "sender").length, 0, "no second hostname resolution at send");
      assert.equal(requests.filter(request => request.kind === "private").length, 0, "private fixture receives no request");
      console.log(`A11 pinned native connect: ${JSON.stringify({ attempts, senderDns: 0, privateRequests: 0 })}`);
    },
  };
}
// Explicit RED replay of the old production wrappers: actual fetch, no private
// wire/body facts, following redirects, and no materialization before launch.
// Never used by production or silently substituted in a GREEN run.
const baseline = process.env.LING_MEDIA_TRANSPORT_BASELINE === "1";
const module = baseline || process.env.LING_A11_SOCKET_CASE ? undefined : await import(process.env.LING_MEDIA_TRANSPORT_MODULE
  ? pathToFileURL(process.env.LING_MEDIA_TRANSPORT_MODULE).href
  : "../dist/features/media/native-http-transport.js");
function transport(options = {}) {
  if (!baseline) return module.createHostMediaNativeTransport({ launch: (_mode, _facts, send) => send(), ...options });
  return {
    async fetch(url, init) {
      let pending;
      try { (options.launch ?? ((_mode, _facts, send) => send()))(
        (init?.method ?? "GET") === "GET" ? "observation" : "forward", undefined,
        () => { pending = fetch(url, init); }); }
      catch (error) {
        if (pending) await pending.then(response => response.body?.cancel()).catch(() => {});
        throw error;
      }
      return pending;
    },
    readExchange: () => undefined,
    readJson: () => undefined,
  };
}
async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}

test("actual JSON HTTP response has immutable Host-issued wire/body facts", async t => {
  const body = '{"id":"exact-task"}';
  const base = await server(t, (_req, res) => { res.setHeader("content-type", "application/json"); res.end(body); });
  const client = transport();
  const response = await client.fetch(`${base}/submit`, { method: "POST", body: "{}" });
  assert.equal(await response.text(), body);
  const exchange = client.readExchange(response);
  assert.equal(exchange.httpStatus, 200);
  assert.equal(exchange.bodySha256, sha(body));
  assert.equal(exchange.request.routeDigest, sha(`${base}/submit`));
  assert.equal(exchange.request.bodySha256, sha("{}"));
  assert.ok(Object.isFrozen(exchange) && Object.isFrozen(exchange.request));
  assert.deepEqual(client.readJson(exchange), { id: "exact-task" });
});

test("FormData boundary and digest use the exact materialized bytes received upstream", async t => {
  let sentBody, contentType, length;
  const base = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    sentBody = Buffer.concat(chunks); contentType = req.headers["content-type"]; length = req.headers["content-length"];
    res.end("uploaded");
  });
  const form = new FormData(); form.append("image", new Blob(["image-bytes"]), "input.png"); form.append("overwrite", "false");
  const client = transport(); const response = await client.fetch(`${base}/upload`, { method: "POST", body: form });
  const request = client.readExchange(response).request;
  assert.equal(request.bodySha256, sha(sentBody));
  assert.equal(request.bodySizeBytes, sentBody.length);
  assert.equal(request.headers["content-type"], contentType);
  assert.equal(request.headers["content-length"], length);
  const boundary = contentType.split("boundary=")[1];
  assert.ok(sentBody.includes(Buffer.from(`--${boundary}`)));
  assert.equal(request.wireDigest, sha(JSON.stringify({ schemaVersion: 1, method: "POST",
    routeDigest: request.routeDigest, headers: request.headers, bodySha256: request.bodySha256,
    bodySizeBytes: request.bodySizeBytes })));
});

test("the launch gate receives already materialized request facts, never an intent hash", async t => {
  let sends = 0, prepared;
  const base = await server(t, (_req, res) => { sends++; res.end("done"); });
  const client = transport({ launch: (_mode, facts, send) => {
    prepared = facts; assert.equal(facts.bodySha256, sha("fixed-bytes")); send();
  } });
  await client.fetch(`${base}/submit`, { method: "POST", body: "fixed-bytes" });
  assert.equal(sends, 1); assert.equal(prepared.method, "POST");
});

test("mutation of caller headers during materialization cannot change the sent request", async t => {
  let auth;
  const base = await server(t, (req, res) => { auth = req.headers.authorization; res.end("ok"); });
  const headers = new Headers({ authorization: "Bearer original-secret", "content-type": "application/json" });
  const client = transport(); const pending = client.fetch(`${base}/submit`, { method: "POST", body: "{}", headers });
  headers.set("authorization", "Bearer mutated-secret");
  const response = await pending;
  assert.equal(auth, "Bearer original-secret");
  const serialized = JSON.stringify(client.readExchange(response));
  assert.ok(!serialized.includes("original-secret") && !serialized.includes("mutated-secret"));
});

test("forward redirect cannot POST or GET to a different namespace", async t => {
  let targetSends = 0;
  const target = await server(t, (_req, res) => { targetSends++; res.end("foreign-ack"); });
  const base = await server(t, (_req, res) => { res.writeHead(302, { location: `${target}/foreign` }); res.end("redirect"); });
  const client = transport();
  await assert.rejects(client.fetch(`${base}/submit`, { method: "POST", body: "{}" }), isRedirectError);
  assert.equal(targetSends, 0);
});

test("redirected observation cannot become an original-route terminal fact", async t => {
  let targetSends = 0;
  const target = await server(t, (_req, res) => { targetSends++; res.end('{"status":"succeeded"}'); });
  const base = await server(t, (_req, res) => { res.writeHead(307, { location: `${target}/task` }); res.end(); });
  await assert.rejects(transport().fetch(`${base}/status`, { method: "GET" }), isRedirectError);
  assert.equal(targetSends, 0);
});

test("truncated real response body rejects before any completed exchange callback", async t => {
  let completed = 0;
  const base = await server(t, (_req, res) => {
    res.writeHead(200, { "content-length": "200", "content-type": "application/json" });
    res.write('{"status":'); setImmediate(() => res.destroy());
  });
  const client = transport({ onCompleted: () => { completed++; } });
  await assert.rejects(client.fetch(`${base}/status`, { method: "GET" }));
  assert.equal(completed, 0);
});

test("response budget exhaustion is not an empty successful body receipt", async t => {
  let completed = 0;
  const base = await server(t, (_req, res) => res.end("too-many-response-bytes"));
  const client = transport({ maxResponseBytes: 8, onCompleted: () => { completed++; } });
  await assert.rejects(client.fetch(`${base}/download`, { method: "GET" }), /budget/i);
  assert.equal(completed, 0);
});

test("pre-send admission failure dispatches zero actual requests", async t => {
  let sends = 0;
  const base = await server(t, (_req, res) => { sends++; res.end("unexpected"); });
  const original = new Error("original-admission-closed");
  const client = transport({ launch: () => { throw original; } });
  await assert.rejects(client.fetch(`${base}/submit`, { method: "POST", body: "{}" }), error => error === original);
  assert.equal(sends, 0);
});

test("send then COMMIT failure preserves and observes the original Promise without a retry", async t => {
  let sends = 0, completed = 0;
  const base = await server(t, (_req, res) => { sends++; res.end("original-effect"); });
  const original = new Error("commit-failed-after-send");
  const client = transport({ launch: (_mode, _facts, send) => { send(); throw original; }, onCompleted: () => { completed++; } });
  await assert.rejects(client.fetch(`${base}/submit`, { method: "POST", body: "{}" }), error => error === original);
  assert.equal(sends, 1); assert.equal(completed, 0);
});

test("fake Response, cloned Response and another transport cannot mint exact Host facts", async t => {
  const base = await server(t, (_req, res) => res.end("actual"));
  const client = transport(), other = transport();
  const response = await client.fetch(`${base}/status`, { method: "GET" });
  assert.throws(() => client.readExchange(new Response("fabricated")), /unissued/i);
  assert.throws(() => client.readExchange(response.clone()), /unissued/i);
  assert.throws(() => other.readExchange(response), /unissued/i);
  const exchange = client.readExchange(response);
  assert.throws(() => client.readJson({ ...exchange }), /unissued/i);
});

test("failed non-2xx response is fully drained and never relabeled remote success", async t => {
  let seen;
  const body = '{"error":"failed"}';
  const base = await server(t, (_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end(body); });
  const client = transport({ onCompleted: exchange => { seen = exchange; } });
  const response = await client.fetch(`${base}/submit`, { method: "POST", body: "{}" });
  assert.equal(response.status, 503); assert.equal(response.ok, false);
  assert.equal(seen.httpStatus, 503); assert.equal(seen.bodySha256, sha(body));
  assert.equal("safe" in seen, false); assert.equal("outcome" in seen, false);
});

test("a launch hook cannot send twice or resume a send after its synchronous gate returns", async t => {
  let sends = 0;
  const base = await server(t, (_req, res) => { sends++; res.end("one-effect"); });
  const duplicate = transport({ launch: (_mode, _facts, send) => { send(); send(); } });
  await assert.rejects(duplicate.fetch(`${base}/submit`, { method: "POST", body: "{}" }), /exact_launch/);
  assert.equal(sends, 1);
  let deferred;
  const late = transport({ launch: (_mode, _facts, send) => { deferred = send; } });
  await assert.rejects(late.fetch(`${base}/submit`, { method: "POST", body: "{}" }), /not_entered/);
  assert.throws(() => deferred(), /exact_launch/);
  assert.equal(sends, 1);
});

test("URL fragments are not wire routes or evidence of a redirect", async t => {
  let receivedRoute;
  const base = await server(t, (req, res) => { receivedRoute = req.url; res.end("same-path"); });
  const client = transport();
  const response = await client.fetch(`${base}/artifact?version=1#download`, { method: "GET" });
  assert.equal(await response.text(), "same-path");
  assert.equal(receivedRoute, "/artifact?version=1");
  assert.equal(client.readExchange(response).request.routeDigest, sha(`${base}/artifact?version=1`));
});

test("bodyless POST includes the actual native content-length zero, without adding it to GET", async t => {
  const upstream = [];
  const base = await server(t, (req, res) => { upstream.push({ method: req.method, length: req.headers["content-length"] }); res.end("ok"); });
  const client = transport();
  const post = await client.fetch(`${base}/cancel`, { method: "POST" });
  const get = await client.fetch(`${base}/status`, { method: "GET" });
  assert.equal(upstream[0].length, "0");
  assert.equal(client.readExchange(post).request.headers["content-length"], "0");
  assert.equal(upstream[1].length, undefined);
  assert.equal(client.readExchange(get).request.headers["content-length"], undefined);
});

test("the actual Daemon SDK import does not break materialized native POST headers", async t => {
  // SDK imports initialize the installed Undici dispatcher. A transport-only
  // unit process does not exercise that production combination.
  await import("../dist/index.js");
  let bytes, length;
  const base = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bytes = Buffer.concat(chunks); length = req.headers["content-length"]; res.end("ack");
  });
  const client = transport();
  const response = await client.fetch(`${base}/submit`, { method: "POST", body: '{"task":"real-combination"}' });
  assert.equal(await response.text(), "ack");
  assert.equal(client.readExchange(response).request.bodySha256, sha(bytes));
  assert.equal(client.readExchange(response).request.headers["content-length"], length);
  const form = new FormData(); form.append("input", new Blob(["sdk-multipart"]), "input.png");
  const multipart = await client.fetch(`${base}/upload`, { method: "POST", body: form });
  assert.equal(client.readExchange(multipart).request.bodySha256, sha(bytes));
  assert.equal(client.readExchange(multipart).request.headers["content-length"], length);
  const noBody = await client.fetch(`${base}/cancel`, { method: "POST" });
  assert.equal(length, "0");
  assert.equal(client.readExchange(noBody).request.headers["content-length"], "0");
});

test("A11 native sender pins the Comfy public_only Host binding through guarded transport", () => {
  runA11SocketCase("comfy-native");
});

test("A11 public sender preserves HTTP Host, TLS SNI and verified certificate hostname", () => {
  runA11SocketCase("preview-tls");
  runA11SocketCase("preview-wrong-tls-host");
  runA11SocketCase("fallback-http");
  runA11SocketCase("fallback-tls");
});

test("A11 per-hop redirects, fail-closed DNS, cancellation and native effect boundaries", () => {
  for (const caseName of ["policy-matrix", "redirect-matrix", "native-failure-matrix", "binding-matrix", "trusted-private", "comfy-redirect", "channel-stall-matrix", "body-budget"]) {
    runA11SocketCase(caseName);
  }
});

test("A11 fixture child", { skip: !process.env.LING_A11_SOCKET_CASE }, async t => {
  const caseName = process.env.LING_A11_SOCKET_CASE;
  console.log(`A11 child entered: ${caseName}`);
  if (caseName === "policy-matrix") return await a11PolicyCases(t);
  if (caseName === "redirect-matrix") return await a11RedirectCases(t);
  if (caseName === "native-failure-matrix") return await a11NativeFailureCases(t);
  if (caseName === "binding-matrix") return await a11BindingCases(t);
  if (caseName === "channel-stall-matrix") return await a11ChannelStallCases(t);
  if (caseName === "trusted-private" || caseName === "comfy-redirect") return await a11ComfyContractCases(t, caseName);
  const secure = caseName.includes("tls");
  const fallback = caseName.startsWith("fallback-");
  const fixture = await a11SocketHarness(t, { secure, forceFirstRefused: fallback,
    ...(fallback ? { answers: async () => [A11_PUBLIC_ADDRESS, A11_PUBLIC_FALLBACK_ADDRESS] } : {}),
    handler: caseName.startsWith("comfy")
    ? (_request, response) => { response.setHeader("content-type", "application/json"); response.end('{"prompt_id":"a11-task"}'); }
    : caseName === "body-budget" ? (_request, response) => { response.setHeader("content-type", "text/plain"); response.end("actual public body ".repeat(200)); }
      : undefined });
  if (caseName.startsWith("harness-")) {
    const host = "sanity.a11.test", url = fixture.url(host);
    // Product-free sanity: native fetch performs the controllable second DNS,
    // then a standards-only fixed lookup performs a fresh public connection.
    assert.deepEqual(await fixture.resolve(host), [A11_PUBLIC_ADDRESS]);
    const unpinned = await globalThis.fetch(url, { signal: AbortSignal.timeout(2_000) });
    assert.match(await unpinned.text(), /actual public body/);
    assert.equal(fixture.attempts[0].address, A11_PRIVATE_ADDRESS);
    assert.equal(fixture.requests[0].kind, "private");
    const received = await new Promise((resolve, reject) => {
      const request = (secure ? httpsRequest : httpRequest)(url, {
        signal: AbortSignal.timeout(2_000), autoSelectFamily: false,
        ...(secure ? { ca: A11_TLS_CERT } : {}),
        lookup: (_hostname, options, callback) => options?.all
          ? callback(null, [{ address: A11_PUBLIC_ADDRESS, family: 4 }])
          : callback(null, A11_PUBLIC_ADDRESS, 4),
      }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString())); response.on("error", reject);
      });
      request.on("error", reject); request.end();
    });
    assert.match(received, /actual public body/);
    assert.equal(fixture.attempts[1].address, A11_PUBLIC_ADDRESS);
    assert.equal(fixture.requests[1].kind, "public");
    assert.equal(fixture.requests[1].host, `${host}:${fixture.port}`);
    if (secure) {
      assert.deepEqual(fixture.serverNames, [host, host]);
      await assert.rejects(globalThis.fetch(fixture.url("wrong.other.test"), { signal: AbortSignal.timeout(2_000) }),
        error => error.cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID");
      assert.equal(fixture.requests.length, 2, "wrong SAN never reaches HTTP");
    }
    console.log(`A11 product-free harness ${caseName}: ${JSON.stringify({ attempts: fixture.attempts,
      requests: fixture.requests.map(({ kind, host }) => ({ kind, host })), serverNames: fixture.serverNames })}`);
    return;
  }
  if (caseName.startsWith("preview") || fallback) {
    const { fetchLinkPreviewMetadata } = await import("../dist/features/channels/link-previews.js");
    const host = caseName === "preview-wrong-tls-host" ? "wrong.other.test" : "preview.a11.test";
    const result = await fetchLinkPreviewMetadata(fixture.url(host));
    if (caseName === "preview-wrong-tls-host") {
      assert.equal(result.status, "failed");
      assert.equal(result.title, null);
      assert.equal(fixture.requests.length, 0, "wrong SAN rejects before HTTP send");
    } else {
      assert.equal(result.status, "ready");
      assert.equal(result.title, "A11 pinned");
      assert.equal(fixture.requests[0].host, `${host}:${fixture.port}`);
      if (secure) assert.deepEqual(fixture.serverNames, [host]);
    }
    if (fallback) {
      assert.deepEqual(fixture.attempts.map(attempt => attempt.address), [A11_PUBLIC_ADDRESS, A11_PUBLIC_FALLBACK_ADDRESS]);
      assert.equal(fixture.requests.length, 1, "connection fallback does not retry the HTTP effect");
    }
    fixture.assertPinned();
    return;
  }
  if (caseName === "body-native" || caseName === "body-budget") {
    const { linkBodyExtractorV1 } = await import("../dist/features/channels/materialization/extractors/link-body.js");
    const url = fixture.url("body.a11.test");
    const result = await linkBodyExtractorV1.materialize({ workspaceId: "workspace_default", channelId: "a11-channel",
      sourceKind: "link_preview", sourceId: "a11-preview", sourceFingerprint: "a11-offline",
      requestedBy: "turn_envelope", maxBytes: caseName === "body-budget" ? 10 : 4096,
      maxChars: caseName === "body-budget" ? 6 : 1000, timeoutMs: 2_000,
      now: "2026-10-13T00:00:00.000Z", resolveHostAddresses: fixture.resolve,
      linkPreview: { id: "a11-preview", url, normalizedUrl: url, status: "ready" } });
    assert.equal(result.status, "available", JSON.stringify(result));
    if (caseName === "body-budget") {
      assert.equal(result.contentText, "actual"); assert.equal(result.byteCount, 10); assert.equal(result.truncated, true);
    } else assert.match(result.contentText, /actual public body/);
    assert.equal(fixture.requests[0].host, `body.a11.test:${fixture.port}`);
    fixture.assertPinned();
    return;
  }
  assert.equal(caseName, "comfy-native");
  await import("../dist/index.js");
  const { ComfyUiClient } = await import("../dist/features/media/workflows/comfyui-client.js");
  const { createGuardedMediaHttpTransport } = await import("../dist/features/media/guarded-native-transport.js");
  const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
  const registry = new MediaLocalExecutionRegistry();
  await registry.runTick({ cwd: "/a11-offline-owned", mediaJobId: "a11-job", workUnitId: "a11-work" }, async execution => {
    const native = createGuardedMediaHttpTransport({ registry, execution, captureAdmissionFailure: error => { throw error; } });
    let originalResponse;
    // Observe the actual guarded transport Response, never substitute a fake.
    const fetchImpl = async (input, init) => { originalResponse = await native.fetch(input, init); return originalResponse; };
    const url = fixture.url("comfy.a11.test", "/");
    const client = new ComfyUiClient({ connection: { id: "a11-connection", workspaceId: "workspace_default",
      name: "owned offline fixture", adapterKind: "comfyui", baseUrl: url, authMode: "bearer",
      networkPolicy: "public_only", protocolVariant: "prompt_legacy", status: "ready",
      createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" },
      apiKey: "a11-offline-fixture-not-a-user-secret", fetchImpl, resolveHostAddresses: fixture.resolve });
    const result = await client.submit({}, "prompt_legacy");
    assert.equal(result.operationId, "a11-task");
    assert.equal(fixture.requests.length, 1, "only one actual submit");
    assert.equal(fixture.requests[0].auth, "Bearer a11-offline-fixture-not-a-user-secret");
    assert.equal(fixture.requests[0].host, `comfy.a11.test:${fixture.port}`);
    const exchange = native.readExchange(originalResponse);
    assert.equal(exchange.request.routeDigest, sha(new URL("/api/prompt", url).toString()));
    assert.ok(!JSON.stringify(exchange).includes("a11-offline-fixture-not-a-user-secret"));
    fixture.assertPinned();
  });
  await registry.waitForIdle();
});

function a11ComfyConnection(baseUrl, overrides = {}) {
  return { id: "a11-connection", workspaceId: "workspace_default", name: "owned offline fixture",
    adapterKind: "comfyui", baseUrl, authMode: "none", networkPolicy: "public_only",
    protocolVariant: "prompt_legacy", status: "ready", createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z", ...overrides };
}

async function a11PolicyCases(t) {
  let mode = "mixed";
  const fixture = await a11SocketHarness(t, { answers: async () => {
    if (mode === "mixed") return [A11_PUBLIC_ADDRESS, "10.0.0.1"];
    if (mode === "empty") return [];
    throw new Error("owned resolver rejection");
  } });
  const { fetchLinkPreviewMetadata } = await import("../dist/features/channels/link-previews.js");
  const { fetchPublicLinkBody } = await import("../dist/features/channels/materialization/extractors/link-body.js");
  const { ComfyUiClient } = await import("../dist/features/media/workflows/comfyui-client.js");
  const { preparePinnedPublicHttpRequest, isLocalOrPrivateHttpAddress } = await import("../dist/shared/public-http-transport.js");
  const url = fixture.url("policy.a11.test");
  for (mode of ["mixed", "empty", "reject"]) {
    const preview = await fetchLinkPreviewMetadata(url);
    assert.equal(preview.status, mode === "mixed" ? "blocked" : "failed");
    assert.deepEqual([preview.title, preview.description, preview.imageUrl, preview.siteName], [null, null, null, null]);
    const body = await fetchPublicLinkBody(url, { fetch: globalThis.fetch, resolveHostAddresses: fixture.resolve,
      maxBytes: 4096, timeoutMs: 100, redirectLimit: 3 });
    assert.equal(body.allowed, false);
    assert.equal(body.reason, mode === "mixed" ? "local_or_private_host" : "dns_failed");
    await assert.rejects(new ComfyUiClient({ connection: a11ComfyConnection(url), resolveHostAddresses: fixture.resolve }).inspect());
  }
  let lateResolve;
  await assert.rejects(preparePinnedPublicHttpRequest(url, {}, { timeoutMs: 20,
    resolveHostAddresses: () => new Promise(resolve => { lateResolve = resolve; }) }), error => error.code === "timeout");
  lateResolve([A11_PUBLIC_ADDRESS]);
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "fe90::1", "::", "0.0.0.0"]) {
    assert.equal(isLocalOrPrivateHttpAddress(address), true, address);
  }
  assert.equal(isLocalOrPrivateHttpAddress("::ffff:203.0.113.10"), false);
  assert.equal(fixture.attempts.length, 0); assert.equal(fixture.requests.length, 0);
}

async function a11RedirectCases(t) {
  let scenario = "relative", approvals = 0;
  const fixture = await a11SocketHarness(t, {
    answers: async () => { approvals++; return scenario === "fresh-private" && approvals > 1 ? ["10.0.0.1"] : [A11_PUBLIC_ADDRESS]; },
    handler: (request, response) => {
      if (request.url === "/final") { response.setHeader("content-type", "text/html"); response.end("<title>A11 redirect</title><main>redirected body</main>"); return; }
      const location = scenario === "absolute" ? fixture.url("next.a11.test", "/final") :
        scenario === "private" ? `http://127.0.0.1:${fixture.port}/private` :
        scenario === "limit" ? "/loop" : "/final";
      response.writeHead(302, scenario === "missing" ? {} : { location }); response.end();
    },
  });
  const { fetchLinkPreviewMetadata } = await import("../dist/features/channels/link-previews.js");
  const { fetchPublicLinkBody } = await import("../dist/features/channels/materialization/extractors/link-body.js");
  for (scenario of ["relative", "absolute", "private", "fresh-private", "missing", "limit"]) {
    for (const product of ["preview", "body"]) {
      approvals = 0;
      const before = fixture.requests.length;
      const url = fixture.url("redirect.a11.test", "/start");
      const result = product === "preview" ? await fetchLinkPreviewMetadata(url) :
        await fetchPublicLinkBody(url, { fetch: globalThis.fetch, resolveHostAddresses: fixture.resolve,
          maxBytes: 4096, timeoutMs: 500, redirectLimit: 1 });
      const success = scenario === "relative" || scenario === "absolute";
      if (product === "preview") {
        assert.equal(result.status, success ? "ready" : ["private", "fresh-private"].includes(scenario) ? "blocked" : "failed");
        if (success) assert.equal(result.title, "A11 redirect");
      } else {
        assert.equal(result.allowed, success);
        if (!success) assert.equal(result.reason, ["private", "fresh-private"].includes(scenario) ? "local_or_private_host" :
          scenario === "missing" ? "redirect_missing_location" : "redirect_limit");
      }
      assert.equal(fixture.requests.length - before, success ? 2 : scenario === "limit" ? (product === "preview" ? 4 : 2) : 1);
      assert.equal(approvals, scenario === "private" ? 1 : scenario === "fresh-private" ? 2 : fixture.requests.length - before);
    }
  }
  fixture.assertPinned();
}

async function a11NativeFailureCases(t) {
  let scenario = "ok", completed = 0;
  const fixture = await a11SocketHarness(t, { handler: (_request, response) => {
    if (scenario === "headers-stall") return;
    if (scenario === "body-stall" || scenario === "external-cancel") { response.writeHead(200); response.write("partial"); return; }
    if (scenario === "truncated") { response.writeHead(200, { "content-length": "100" }); response.write("partial"); setImmediate(() => response.destroy()); return; }
    response.end("actual-response");
  } });
  const { createHostMediaNativeTransport } = await import("../dist/features/media/native-http-transport.js");
  const { preparePinnedPublicHttpRequest } = await import("../dist/shared/public-http-transport.js");
  const { Client } = await import("undici");
  for (scenario of ["admission", "commit", "truncated", "budget", "headers-stall", "body-stall", "external-cancel", "cleanup"]) {
    const before = fixture.requests.length;
    const original = new Error(`a11-${scenario}`);
    const native = createHostMediaNativeTransport({ onCompleted: () => { completed++; },
      ...(scenario === "budget" ? { maxResponseBytes: 2 } : {}), launch: (_mode, _facts, send) => {
        if (scenario === "admission") throw original;
        send(); if (scenario === "commit") throw original;
      } });
    const controller = new AbortController();
    const prepared = await preparePinnedPublicHttpRequest(fixture.url("native.a11.test", "/submit"),
      { method: "POST", body: "fixed-effect", signal: controller.signal },
      { timeoutMs: scenario.includes("stall") ? 40 : 500, resolveHostAddresses: fixture.resolve });
    const cancelTimer = scenario === "external-cancel" ? setTimeout(() => controller.abort(), 40) : undefined;
    const originalDestroy = Client.prototype.destroy;
    if (scenario === "cleanup") Client.prototype.destroy = function (...args) {
      if (typeof args.at(-1) === "function") return originalDestroy.apply(this, args);
      return originalDestroy.apply(this, args).then(() => { throw new Error("a11-cleanup-failed"); });
    };
    try {
      await assert.rejects(prepared.fetch(native.fetch), error => ["admission", "commit"].includes(scenario) ? error === original :
        scenario === "cleanup" ? error.message === "a11-cleanup-failed" : true);
    } finally { Client.prototype.destroy = originalDestroy; if (cancelTimer) clearTimeout(cancelTimer); }
    assert.equal(fixture.requests.length - before, scenario === "admission" ? 0 : 1, scenario);
    assert.equal(completed, 0, scenario);
  }
  fixture.assertPinned();
}

async function a11BindingCases(t) {
  const fixture = await a11SocketHarness(t);
  const { createHostMediaNativeTransport } = await import("../dist/features/media/native-http-transport.js");
  const { preparePinnedPublicHttpRequest } = await import("../dist/shared/public-http-transport.js");
  const native = createHostMediaNativeTransport({ launch: (_mode, _facts, send) => send() });
  const prepare = (init = {}) => preparePinnedPublicHttpRequest(fixture.url("binding.a11.test"), init,
    { timeoutMs: 500, resolveHostAddresses: fixture.resolve });
  const cloned = await prepare();
  assert.throws(() => cloned.request.clone(), /clone_rejected/);
  await assert.rejects(cloned.fetch((input, init) => native.fetch(new Request(input, init))), /missing_or_cloned/);
  const wrong = await prepare();
  await assert.rejects(wrong.fetch((_input, init) => native.fetch(fixture.url("other.a11.test"), init)), /url_mismatch/);
  const expired = new AbortController(); expired.abort();
  await assert.rejects(prepare({ signal: expired.signal }), error => error.code === "timeout");
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.attempts.length, 0);
  const once = await prepare();
  const response = await once.fetch(native.fetch);
  assert.match(await response.text(), /actual public body/);
  await assert.rejects(once.fetch(native.fetch), error => error.code === "timeout" || /reused/u.test(error.message));
  await assert.rejects(native.fetch(once.request), /reused/);
  assert.equal(fixture.requests.length, 1);
  fixture.assertPinned();
}

async function a11ComfyContractCases(t, caseName) {
  let redirectCode = 302;
  const fixture = await a11SocketHarness(t, { allowTrustedLoopback: caseName === "trusted-private", handler: (_request, response) => {
    if (caseName === "comfy-redirect") { response.writeHead(redirectCode, { location: fixture.url("other.a11.test", "/foreign") }); response.end(); }
    else { response.setHeader("content-type", "application/json"); response.end('{"prompt_id":"a11-trusted-task"}'); }
  } });
  const { ComfyUiClient } = await import("../dist/features/media/workflows/comfyui-client.js");
  const { createGuardedMediaHttpTransport } = await import("../dist/features/media/guarded-native-transport.js");
  const { MediaLocalExecutionRegistry } = await import("../dist/runtime/media-local-executions.js");
  const registry = new MediaLocalExecutionRegistry();
  await registry.runTick({ cwd: "/a11-offline-owned", mediaJobId: "a11-contract-job", workUnitId: "a11-contract-work" }, async execution => {
    const native = createGuardedMediaHttpTransport({ registry, execution, captureAdmissionFailure: error => { throw error; } });
    let responses = 0;
    const client = new ComfyUiClient({ connection: a11ComfyConnection(fixture.url(caseName === "trusted-private" ? "127.0.0.1" : "comfy.a11.test", "/"),
      caseName === "trusted-private" ? { networkPolicy: "trusted_private_network" } : {}),
      resolveHostAddresses: fixture.resolve, fetchImpl: async (input, init) => { const response = await native.fetch(input, init); responses++; return response; } });
    if (caseName === "trusted-private") {
      assert.equal((await client.submit({}, "prompt_legacy")).operationId, "a11-trusted-task");
      assert.equal(fixture.dnsCalls.length, 0); assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.attempts[0].address, "127.0.0.1"); assert.equal(responses, 1);
    } else {
      for (redirectCode of [302, 307]) await assert.rejects(client.submit({}, "prompt_legacy"), isRedirectError);
      assert.equal(fixture.requests.length, 2); assert.equal(responses, 0);
      assert.ok(fixture.requests.every(request => request.route === "/api/prompt"));
      fixture.assertPinned();
    }
  });
  await registry.waitForIdle();
}

async function a11ChannelStallCases(t) {
  let scenario = "headers", resolveLate;
  const fixture = await a11SocketHarness(t, {
    answers: () => scenario === "dns" ? new Promise(resolve => { resolveLate = resolve; }) : Promise.resolve([A11_PUBLIC_ADDRESS]),
    handler: (_request, response) => { if (scenario === "body") { response.writeHead(200, { "content-type": "text/html" }); response.write("<main>partial"); } },
  });
  const { fetchLinkPreviewMetadata } = await import("../dist/features/channels/link-previews.js");
  const { fetchPublicLinkBody } = await import("../dist/features/channels/materialization/extractors/link-body.js");
  const url = fixture.url("stall.a11.test");
  for (scenario of ["headers", "body", "dns"]) {
    const before = fixture.requests.length;
    const body = await fetchPublicLinkBody(url, { fetch: globalThis.fetch, resolveHostAddresses: fixture.resolve,
      maxBytes: 128, timeoutMs: 30, redirectLimit: 1 });
    assert.equal(body.allowed, false); assert.equal(body.reason, "timeout", scenario);
    assert.equal(fixture.requests.length - before, scenario === "dns" ? 0 : 1);
    if (scenario === "dns") { resolveLate([A11_PUBLIC_ADDRESS]); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  for (scenario of ["headers", "dns"]) {
    const before = fixture.requests.length;
    const preview = await fetchLinkPreviewMetadata(url);
    assert.equal(preview.status, "failed"); assert.equal(preview.title, null);
    assert.equal(fixture.requests.length - before, scenario === "dns" ? 0 : 1);
    if (scenario === "dns") { resolveLate([A11_PUBLIC_ADDRESS]); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  fixture.assertPinned();
}
