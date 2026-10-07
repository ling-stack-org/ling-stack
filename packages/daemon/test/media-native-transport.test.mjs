import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sha = value => createHash("sha256").update(value).digest("hex");
const isRedirectError = error => /redirect/i.test(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`);
// Explicit RED replay of the old production wrappers: actual fetch, no private
// wire/body facts, following redirects, and no materialization before launch.
// Never used by production or silently substituted in a GREEN run.
const baseline = process.env.LING_MEDIA_TRANSPORT_BASELINE === "1";
const module = baseline ? undefined : await import(process.env.LING_MEDIA_TRANSPORT_MODULE
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
