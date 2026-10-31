import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fetch as nativeFetch } from "undici";
import { createA11PublicHttpNetworkFixture } from "./support/a11-public-http-network-fixture.mjs";

// Load the exact authored route and transport without a Daemon, database,
// rebuilt dist, or process-global source-resolution fallback.
const routeUrl = new URL("../src/features/skills/marketplace-route.ts", import.meta.url).href;
const responseUrl = new URL("../src/shared/response.ts", import.meta.url).href;
const transportUrl = new URL("../src/shared/public-http-transport.ts", import.meta.url).href;
const contractUrl = new URL("../../contracts/src/marketplace.ts", import.meta.url).href;
const sources = new Set([routeUrl, responseUrl, transportUrl, contractUrl]);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === routeUrl) {
      const mapped = {
        "@ling-stack/contracts": contractUrl,
        "../../shared/response.js": responseUrl,
        "../../shared/public-http-transport.js": transportUrl,
      }[specifier];
      if (mapped) return { shortCircuit: true, url: mapped };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (sources.has(url)) return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }) };
    return next(url, context);
  },
});
let handleSkillsMarketplaceInspect, isLocalOrPrivateHttpAddress;
try {
  ({ handleSkillsMarketplaceInspect } = await import(routeUrl));
  ({ isLocalOrPrivateHttpAddress } = await import(transportUrl));
}
finally { hook.deregister(); }

const MAX_BYTES = 2 * 1024 * 1024;
const validIndex = { indexVersion: 1, skills: [{ id: "offline", name: "Offline fixture", versions: [
  { version: "1.0.0", url: "https://cdn.example.com/offline.lingpack", integrity: `sha256-${"a".repeat(64)}` },
] }] };
const indexBytes = Buffer.from(JSON.stringify(validIndex));

async function inspect(indexUrl, webFetch) {
  const headers = new Map();
  const response = {
    setHeader(name, value) { headers.set(name, value); },
    writeHead(status, extra) { this.status = status; Object.entries(extra).forEach(([key, value]) => headers.set(key, value)); },
    end(body) { this.body = JSON.parse(body); },
  };
  await handleSkillsMarketplaceInspect({ method: "GET", headers: {},
    url: `/skills/marketplace/inspect?url=${encodeURIComponent(indexUrl)}` }, response,
  { config: { host: "127.0.0.1", port: 0 }, ...(webFetch ? { webFetch } : {}) });
  return { status: response.status, body: response.body };
}

test("marketplace source: shared CGNAT boundary preserves adjacent public ranges and mapped IPv6", () => {
  for (const address of ["100.64.0.0", "100.127.255.255", "::ffff:100.100.100.200"]) assert.equal(isLocalOrPrivateHttpAddress(address), true, address);
  for (const address of ["100.63.255.255", "100.128.0.0", "203.0.113.10", "::ffff:203.0.113.10"]) assert.equal(isLocalOrPrivateHttpAddress(address), false, address);
});

test("marketplace source: rejects private and mixed DNS before invoking the sender", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  let sends = 0;
  const sender = async () => { sends++; return new Response(indexBytes); };
  for (const addresses of [["127.0.0.1"], ["10.1.2.3"], ["172.16.1.2"], ["192.168.1.2"], ["100.64.0.1"], ["100.100.100.200"],
    ["169.254.169.254"], ["::1"], ["fd00::1"], ["::ffff:127.0.0.1"], ["203.0.113.10", "127.0.0.1"]]) {
    fixture.setDnsAnswers(addresses);
    const result = await inspect(`${fixture.baseUrl}/index.json`, sender);
    assert.equal(result.status, 400, JSON.stringify({ addresses, result }));
    assert.equal(result.body.error, "index_unsafe_url");
  }
  assert.equal(sends, 0);
  assert.equal(fixture.connects.length, 0);
});

test("marketplace source: default sender is pinned, not the global fetch fallback", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(_request, response) { response.end(indexBytes); } });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("uncontrolled-global-fetch-used"); };
  try {
    const result = await inspect(`${fixture.baseUrl}/index.json`);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.skills[0].id, "offline");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.connects[0].address, "203.0.113.10");
    assert.equal(fixture.serverNames[0], fixture.hostname);
    assert.equal(fixture.tlsConnections[0].authorized, true);
  } finally { globalThis.fetch = previous; }
});

test("marketplace source: DNS rebinding cannot cause a second native lookup", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(_request, response) { response.end(indexBytes); } });
  const previous = dns.lookup;
  let secondLookups = 0;
  try {
    const result = await inspect(`${fixture.baseUrl}/index.json`, async (url, init) => {
      dns.lookup = (_hostname, options, callback) => {
        secondLookups++;
        if (typeof options === "function") { callback = options; options = {}; }
        queueMicrotask(() => options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4));
      };
      syncBuiltinESMExports();
      return nativeFetch(url, init);
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(secondLookups, 0);
    assert.equal(fixture.dnsLookups.filter(item => item.kind === "approval").length, 1);
    assert.equal(fixture.connects[0].address, "203.0.113.10");
  } finally { dns.lookup = previous; syncBuiltinESMExports(); }
});

test("marketplace source: follows a bounded public HTTPS redirect with separate DNS approval", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(request, response) {
      if (request.url === "/start") { response.writeHead(302, { location: "/index.json" }); response.end(); }
      else response.end(indexBytes);
    } });
  const result = await inspect(`${fixture.baseUrl}/start`, nativeFetch);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.source, `${fixture.baseUrl}/start`);
  assert.deepEqual(fixture.requests.map(item => item.path), ["/start", "/index.json"]);
  assert.equal(fixture.dnsLookups.filter(item => item.kind === "approval").length, 2);
});

test("marketplace source: rejects HTTPS downgrade, credentials and private redirects before sending", async t => {
  let destination = "http://preview.a11.test/index.json";
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(_request, response) { response.writeHead(302, { location: destination }); response.end(); } });
  for (const url of ["http://preview.a11.test/index.json", "https://127.0.0.1/index.json", "https://user:password@preview.a11.test/index.json"]) {
    destination = url;
    const before = fixture.requests.length;
    const result = await inspect(`${fixture.baseUrl}/start`, nativeFetch);
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal(result.body.error, "index_unsafe_url");
    assert.equal(fixture.requests.length, before + 1);
  }
  const before = fixture.requests.length;
  const result = await inspect(`https://user:password@preview.a11.test:${fixture.port}/index.json`, nativeFetch);
  assert.equal(result.status, 400);
  assert.equal(fixture.requests.length, before);
});

test("marketplace source: rechecks redirected DNS and bounds redirect loops", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  let sends = 0;
  const privateRedirect = await inspect(`${fixture.baseUrl}/start`, async () => {
    sends++;
    fixture.setDnsAnswers(["127.0.0.1"]);
    return new Response(null, { status: 302, headers: { location: "/private" } });
  });
  assert.equal(privateRedirect.status, 400, JSON.stringify(privateRedirect));
  assert.equal(sends, 1);
  fixture.setDnsAnswers(["203.0.113.10"]);
  sends = 0;
  const loop = await inspect(`${fixture.baseUrl}/loop`, async () => {
    sends++;
    return new Response(null, { status: 302, headers: { location: "/loop" } });
  });
  assert.equal(loop.status, 502);
  assert.equal(loop.body.error, "index_redirect_limit");
  assert.equal(sends, 4);
});

test("marketplace source: non-2xx cannot masquerade as a valid index", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  let cancelled = 0;
  const result = await inspect(`${fixture.baseUrl}/index.json`, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(indexBytes); },
    cancel() { cancelled++; },
  }), { status: 503 }));
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "index_http_error");
  assert.equal(cancelled, 1);
});

test("marketplace source: enforces 2MiB UTF-8 bytes rather than JS characters and cancels overflow", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  const payload = Buffer.from(JSON.stringify({ ...validIndex, padding: "汉".repeat(Math.floor(MAX_BYTES / 3)) }));
  assert.ok(payload.byteLength > MAX_BYTES);
  assert.ok(payload.toString().length < MAX_BYTES);
  let cancelled = 0;
  const result = await inspect(`${fixture.baseUrl}/index.json`, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(payload.subarray(0, MAX_BYTES)); controller.enqueue(payload.subarray(MAX_BYTES)); },
    cancel() { cancelled++; },
  })));
  assert.equal(result.status, 413, JSON.stringify(result));
  assert.equal(result.body.error, "index_too_large");
  assert.equal(cancelled, 1);
});

test("marketplace source: accepts the exact byte cap and preserves multibyte split boundaries", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  const bytes = Buffer.from(JSON.stringify({ ...validIndex, padding: "汉字" }));
  const padded = Buffer.concat([bytes, Buffer.alloc(MAX_BYTES - bytes.length, 0x20)]);
  let offset = 0;
  const result = await inspect(`${fixture.baseUrl}/index.json`, async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset >= padded.length) { controller.close(); return; }
      const next = offset < bytes.length ? offset + 1 : padded.length;
      controller.enqueue(padded.subarray(offset, next)); offset = next;
    },
  })));
  assert.equal(result.status, 200, JSON.stringify(result));
});

test("marketplace source: DNS failures, invalid encodings, invalid contracts and cleanup errors fail closed", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  let sends = 0;
  const sender = async () => { sends++; return new Response(indexBytes); };
  fixture.setDnsAnswers([]);
  assert.equal((await inspect(`${fixture.baseUrl}/index.json`, sender)).status, 502);
  fixture.setDnsFailure(new Error("owned fixture DNS failure"));
  assert.equal((await inspect(`${fixture.baseUrl}/index.json`, sender)).status, 502);
  assert.equal(sends, 0);
  fixture.setDnsAnswers(["203.0.113.10"]);
  for (const [makeResponse, status, code] of [
    [() => new Response("not json"), 502, "index_not_json"],
    [() => new Response(Uint8Array.of(0xff)), 502, "index_not_utf8"],
    [() => new Response(JSON.stringify({ indexVersion: 2, skills: [] })), 422, "index_invalid"],
    [() => new Response(null, { status: 302 }), 502, "index_redirect_invalid"],
    [() => new Response(new ReadableStream({ start(controller) { controller.error(new Error("owned body failure")); } })), 502, "index_fetch_failed"],
    [() => new Response(new ReadableStream({ cancel() { throw new Error("owned cancellation failure"); } }), { status: 503 }), 502, "index_fetch_failed"],
  ]) {
    const result = await inspect(`${fixture.baseUrl}/index.json`, async () => makeResponse());
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.body.error, code, JSON.stringify(result));
  }
  assert.equal(fixture.connects.length, 0);
});

test("marketplace source: native body deadline closes the owned TLS peer", async t => {
  let totalDeadline, closePeer;
  const peerClosed = new Promise(resolve => { closePeer = resolve; });
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true,
    onRequest(request, response) {
      request.socket.once("close", closePeer);
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    } });
  const previous = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 15_000);
    totalDeadline = new AbortController();
    return totalDeadline.signal;
  };
  try {
    let headersObserved = false;
    const result = await inspect(`${fixture.baseUrl}/index.json`, async (url, init) => {
      const response = await nativeFetch(url, init);
      headersObserved = true;
      setImmediate(() => totalDeadline.abort(new DOMException("Owned body deadline", "TimeoutError")));
      return response;
    });
    assert.equal(headersObserved, true);
    assert.equal(result.status, 504, JSON.stringify(result));
    await peerClosed;
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.connects.length, 1);
  } finally { AbortSignal.timeout = previous; }
});

test("marketplace source: one absolute deadline covers DNS, headers and body", async t => {
  const fixture = await createA11PublicHttpNetworkFixture(t, { secure: true });
  const previous = AbortSignal.timeout;
  let active;
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 15_000);
    active = new AbortController();
    return active.signal;
  };
  try {
    fixture.setDnsStall();
    const dnsResult = inspect(`${fixture.baseUrl}/index.json`, nativeFetch);
    while (!active) await new Promise(resolve => setImmediate(resolve));
    active.abort(new DOMException("Fixture total deadline", "TimeoutError"));
    assert.equal((await dnsResult).status, 504);
    fixture.releaseDnsStall();

    active = undefined;
    const headerResult = inspect(`${fixture.baseUrl}/index.json`, async (_url, init) => {
      active.abort(new DOMException("Fixture total deadline", "TimeoutError"));
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    });
    assert.equal((await headerResult).status, 504);

    let cancelled = 0;
    const bodyResult = await inspect(`${fixture.baseUrl}/index.json`, async () => new Response(new ReadableStream({
      pull() { active.abort(new DOMException("Fixture total deadline", "TimeoutError")); },
      cancel() { cancelled++; },
    })));
    assert.equal(bodyResult.status, 504);
    assert.equal(cancelled, 1);
  } finally { AbortSignal.timeout = previous; }
});
