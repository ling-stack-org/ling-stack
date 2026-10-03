import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const moduleUrl = process.env.LING_MEDIA_OBSERVATIONS_MODULE
  ? pathToFileURL(process.env.LING_MEDIA_OBSERVATIONS_MODULE)
  : new URL("../dist/features/media/native-receipt-observations.js", import.meta.url);
let observations;
try { observations = await import(moduleUrl.href); }
catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
const sha = value => createHash("sha256").update(value).digest("hex");
function api() { assert.ok(observations, "new fixed native receipt observation module must exist"); return observations; }
async function native() {
  const module = await import(pathToFileURL(join(dirname(moduleUrl.pathname), "native-http-transport.js")).href);
  return module.createHostMediaNativeTransport({ launch: (_mode, _request, send) => send() });
}
async function server(t, handler) {
  const instance = createServer(handler); instance.listen(0, "127.0.0.1"); await once(instance, "listening");
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
function json(res, value, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function exchange(client, url, method = "GET", body) {
  const response = await client.fetch(url, { method, ...(body === undefined ? {} : { body }) });
  return client.readExchange(response);
}
function plan(protocol, baseUrl, outputRules) {
  return api().createMediaNativeObservationPlan({ protocol, adapterId: "actual-adapter", baseUrl, ...(outputRules ? { outputRules } : {}) });
}

test("native observation plans reject credentials/query/hash/unknown protocol and freeze effective namespace", () => {
  const create = api().createMediaNativeObservationPlan;
  for (const baseUrl of ["file:///tmp/media", "https://user:secret@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#fragment"]) {
    assert.throws(() => create({ protocol: "image_response_v1", adapterId: "images", baseUrl }));
  }
  assert.throws(() => create({ protocol: "unknown", adapterId: "images", baseUrl: "https://example.test" }));
  const image = plan("image_response_v1", "https://EXAMPLE.test:443/v1///");
  assert.equal(image.namespaceDigest, sha("https://example.test/v1")); assert.ok(Object.isFrozen(image));
  const comfy = plan("comfy_jobs_v1", "https://EXAMPLE.test:443/ignored-prefix/");
  assert.equal(comfy.namespaceDigest, sha("https://example.test"));
});

test("effect classification uses exact actual routes, blocks unknown/cancel POST, and accepts actual multipart", async t => {
  api(); let received;
  const base = await server(t, async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); received = Buffer.concat(chunks); json(res, { name: "upload.png" }); });
  const client = await native(), scope = plan("comfy_jobs_v1", `${base}/ignored-prefix`);
  const form = new FormData(); form.append("image", new Blob(["actual-image"]), "upload.png");
  const actual = await exchange(client, `${base}/api/upload/image`, "POST", form);
  assert.equal(scope.effectKind(actual.request), "comfy_image_upload"); assert.equal(actual.request.bodySha256, sha(received));
  assert.equal(scope.effectKind({ method: "POST", routeDigest: sha(`${base}/api/prompt`) }), "remote_generation_submit");
  assert.equal(scope.effectKind({ method: "GET", routeDigest: sha(`${base}/api/object_info`) }), undefined);
  for (const url of [`${base}/api/jobs/id/cancel`, `${base}/api/prompt?foreign=1`, `${base}/ignored-prefix/api/prompt`]) {
    assert.throws(() => scope.effectKind({ method: "POST", routeDigest: sha(url) }), /route/);
  }
});

test("Seedance submission decodes actual root/data ID and rejects conflicting or missing identity", async t => {
  api(); let value = { id: "task/exact" };
  const base = await server(t, (_req, res) => json(res, value)); const client = await native(), scope = plan("seedance_task_v1", `${base}/v1/`);
  const decode = api().decodeMediaNativeSubmission;
  let actual = await exchange(client, `${base}/v1/contents/generations/tasks`, "POST", "{}");
  const submission = decode(scope, client, actual);
  assert.equal(submission.externalOperationId, "task/exact");
  assert.equal(submission.statusRouteUrl, `${base}/v1/contents/generations/tasks/task%2Fexact`);
  assert.equal(submission.statusRouteDigest, sha(submission.statusRouteUrl));
  value = { data: { id: "nested" } }; actual = await exchange(client, `${base}/v1/contents/generations/tasks`, "POST", "{}");
  assert.equal(decode(scope, client, actual).externalOperationId, "nested");
  for (const bad of [{ id: "one", data: { id: "foreign" } }, { id: " padded " }, { id: 42 }, { safe: true, externalOperationId: "model" }]) {
    value = bad; actual = await exchange(client, `${base}/v1/contents/generations/tasks`, "POST", "{}"); assert.equal(decode(scope, client, actual), undefined);
  }
});

test("Comfy submission requires actual prompt_id and cannot adopt a foreign route or non-2xx", async t => {
  api(); let value = { prompt_id: "prompt" }, status = 200;
  const base = await server(t, (_req, res) => json(res, value, status)); const client = await native(), scope = plan("comfy_jobs_v1", base);
  const decode = api().decodeMediaNativeSubmission;
  assert.equal(decode(scope, client, await exchange(client, `${base}/api/prompt`, "POST", "{}")).externalOperationId, "prompt");
  value = { id: "only-alias" }; assert.equal(decode(scope, client, await exchange(client, `${base}/api/prompt`, "POST", "{}")), undefined);
  value = { prompt_id: "prompt", id: "foreign" }; assert.equal(decode(scope, client, await exchange(client, `${base}/api/prompt`, "POST", "{}")), undefined);
  value = { prompt_id: "prompt" }; assert.equal(decode(scope, client, await exchange(client, `${base}/elsewhere`, "POST", "{}")), undefined);
  status = 503; assert.equal(decode(scope, client, await exchange(client, `${base}/api/prompt`, "POST", "{}")), undefined);
});

test("fake transport, fake Response, cloned exchange and foreign namespace cannot mint observations", async t => {
  api(); const base = await server(t, (_req, res) => json(res, { id: "exact" }));
  const client = await native(), other = await native(), scope = plan("seedance_task_v1", base);
  const actual = await exchange(client, `${base}/contents/generations/tasks`, "POST", "{}");
  assert.throws(() => api().decodeMediaNativeSubmission(scope, { ...client }, actual), /unissued/);
  assert.throws(() => api().decodeMediaNativeSubmission(scope, client, { ...actual }), /unissued/);
  assert.throws(() => api().decodeMediaNativeSubmission(scope, other, actual), /unissued/);
  assert.throws(() => client.readExchange(new Response('{"id":"fabricated"}')), /unissued/);
  assert.equal(api().decodeMediaNativeSubmission(plan("seedance_task_v1", `${base}/foreign`), client, actual), undefined);
});

test("Seedance terminal requires exact GET route and ID; pending/unknown/foreign task never become terminal", async t => {
  api(); let value = { id: "exact", status: "succeeded", content: { video_url: "https://cdn.test/final.mp4" } };
  const base = await server(t, (_req, res) => json(res, value)), client = await native(), scope = plan("seedance_task_v1", base);
  const route = scope.statusRoute("exact"), decode = api().decodeMediaNativeTerminal;
  const terminal = decode(scope, client, await exchange(client, route.url), "exact");
  assert.equal(terminal.observation.outcome, "completed"); assert.equal(terminal.videoUrl, value.content.video_url);
  assert.equal(decode(scope, client, await exchange(client, `${base}/foreign`), "exact"), undefined);
  assert.equal(decode(scope, client, await exchange(client, route.url, "POST", "{}"), "exact"), undefined);
  for (const bad of [{ id: "foreign", status: "succeeded" }, { id: "exact", status: "running" }, { id: "exact", status: "unknown" }, { id: "exact", status: "succeeded", data: { id: "exact", status: "failed" } }]) {
    value = bad; assert.equal(decode(scope, client, await exchange(client, route.url), "exact"), undefined);
  }
});

test("Comfy jobs and legacy use closed decoders and only fixed same-task status routes", async t => {
  api(); let value = { id: "exact", status: "completed", outputs: {} };
  const base = await server(t, (_req, res) => json(res, value)), client = await native(), jobs = plan("comfy_jobs_v1", base);
  const decode = api().decodeMediaNativeTerminal;
  assert.equal(decode(jobs, client, await exchange(client, jobs.statusRoute("exact").url), "exact").observation.outcome, "completed");
  for (const bad of [{ id: "foreign", status: "completed" }, { id: "exact", status: "pending" }, { id: "exact", status: "completed", execution_status: { status_str: "error", completed: false } }]) {
    value = bad; assert.equal(decode(jobs, client, await exchange(client, jobs.statusRoute("exact").url), "exact"), undefined);
  }
  const legacy = plan("comfy_prompt_legacy_v1", base);
  value = { exact: { status: { status_str: "success", completed: true }, outputs: {} } };
  assert.equal(decode(legacy, client, await exchange(client, legacy.statusRoute("exact").url), "exact").observation.identitySource, "exact_history_key");
  const routes = legacy.statusRoutes("exact");
  assert.deepEqual(routes.map(route => route.url), [`${base}/api/history_v2/exact`, `${base}/api/history/exact`, `${base}/history/exact`]);
  for (const route of routes) assert.equal(decode(legacy, client, await exchange(client, route.url), "exact").observation.identitySource, "exact_history_key");
  for (const url of [`${base}/api/history/foreign`, `${base}/api/history/exact?foreign=1`, `${base}/other/exact`]) {
    assert.equal(decode(legacy, client, await exchange(client, url), "exact"), undefined);
  }
  value = { foreign: value.exact }; assert.equal(decode(legacy, client, await exchange(client, legacy.statusRoute("exact").url), "exact"), undefined);
});

test("native matcher accepts only deterministic redacted JSON response, retaining raw native lineage", async t => {
  api(); const secret = "synthetic-configured-value", body = { data: [{ b64_json: Buffer.from("image").toString("base64") }],
    token: "synthetic-private-token", debug: { note: `echo ${secret}`, visible: "real-fact" } };
  const base = await server(t, (_req, res) => json(res, body)), client = await native();
  const scope = plan("image_response_v1", base), matcher = api().createMediaNativeRemoteDescriptorMatcher(scope, [secret]);
  const actual = await exchange(client, `${base}/images/generations`, "POST", "{}");
  matcher.capture(client, actual);
  const response = { ...body, token: "[REDACTED]", debug: { note: "echo [REDACTED]", visible: "real-fact" } };
  const diagnostic = { type: "json", content: JSON.stringify({ response }) };
  assert.equal(matcher.getRemoteDescriptor(diagnostic, 0).responseBodySha256, actual.bodySha256);
  assert.equal(matcher.getRemoteDescriptor({ ...diagnostic, content: JSON.stringify({ response: body }) }, 0), undefined);
  assert.equal(matcher.getRemoteDescriptor({ ...diagnostic, content: JSON.stringify({ response: { ...response, debug: { ...response.debug, visible: "forged" } } }) }, 0), undefined);
});

test("image b64 matcher binds actual candidate bytes and exact response JSON, never business summary claims", async t => {
  api(); const bytes = Buffer.from("actual-image"), body = { data: [{ b64_json: bytes.toString("base64") }] };
  const base = await server(t, (_req, res) => json(res, body)), client = await native(), scope = plan("image_response_v1", `${base}/v1`);
  const matcher = api().createMediaNativeRemoteDescriptorMatcher(scope);
  const actual = await exchange(client, `${base}/v1/images/generations`, "POST", "{}"); matcher.capture(client, actual);
  const descriptor = matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes, bytesSha256: "f".repeat(64), safe: true }, 1);
  assert.equal(descriptor.descriptorKind, "response_item"); assert.equal(descriptor.candidateIndex, 1); assert.equal(descriptor.responseBodySha256, actual.bodySha256);
  assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: Buffer.from("fabricated") }, 1), undefined);
  const summary = { type: "json", content: JSON.stringify({ status: "model-success", request: "not-authority", response: body }) };
  assert.equal(matcher.getRemoteDescriptor(summary, 0).descriptorKind, "response_item");
  assert.equal(matcher.getRemoteDescriptor({ ...summary, contentBytes: Buffer.from("foreign persisted bytes") }, 0), undefined);
  assert.equal(matcher.getRemoteDescriptor({ type: "json", content: JSON.stringify({ response: { data: [], safe: true } }) }, 0), undefined);
  assert.equal(matcher.getRemoteDescriptor({ type: "json", content: JSON.stringify({ status: "succeeded" }) }, 0), undefined);
});

test("image download matcher only adopts a route derived from original actual output and matching media bytes", async t => {
  api(); const bytes = Buffer.from("downloaded-image"); let base;
  base = await server(t, (req, res) => req.url === "/v1/images/generations"
    ? json(res, { data: [{ url: `${base}/out/image.png` }] })
    : (res.writeHead(200, { "content-type": "image/png" }), res.end(bytes)));
  const client = await native(), matcher = api().createMediaNativeRemoteDescriptorMatcher(plan("image_response_v1", `${base}/v1`));
  matcher.capture(client, await exchange(client, `${base}/out/unrelated.png`));
  assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes }, 0), undefined);
  matcher.capture(client, await exchange(client, `${base}/v1/images/generations`, "POST", "{}"));
  matcher.capture(client, await exchange(client, `${base}/out/image.png`));
  assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes }, 0).descriptorKind, "download");
  assert.equal(matcher.getRemoteDescriptor({ type: "video", contentBytes: bytes }, 0), undefined);
});

test("matcher refuses poll/discovery JSON as a media output even when an actual output URL points there", async t => {
  api(); let base; const bytes = Buffer.from('{"status":"succeeded"}');
  base = await server(t, (req, res) => req.method === "POST" ? json(res, { data: [{ url: `${base}/api/object_info` }] })
    : (res.writeHead(200, { "content-type": "application/json" }), res.end(bytes)));
  const client = await native(), matcher = api().createMediaNativeRemoteDescriptorMatcher(plan("image_response_v1", base));
  matcher.capture(client, await exchange(client, `${base}/images/generations`, "POST", "{}")); matcher.capture(client, await exchange(client, `${base}/api/object_info`));
  assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes }, 0), undefined);
});

test("Seedance matcher derives download from its own actual exact terminal, rejects foreign/duplicate submission IDs", async t => {
  api(); const bytes = Buffer.from("final-video"); let base, submissionId = "exact";
  base = await server(t, (req, res) => req.method === "POST" ? json(res, { id: submissionId })
    : req.url === "/contents/generations/tasks/exact" ? json(res, { id: "exact", status: "succeeded", content: { video_url: `${base}/out/video.mp4` } })
    : (res.writeHead(200, { "content-type": "video/mp4" }), res.end(bytes)));
  const client = await native(), scope = plan("seedance_task_v1", base), matcher = api().createMediaNativeRemoteDescriptorMatcher(scope);
  matcher.capture(client, await exchange(client, `${base}/contents/generations/tasks`, "POST", "{}"));
  matcher.capture(client, await exchange(client, scope.statusRoute("exact").url)); matcher.capture(client, await exchange(client, `${base}/out/video.mp4`));
  assert.equal(matcher.getRemoteDescriptor({ type: "video", contentBytes: bytes }, 0).descriptorKind, "download");
  submissionId = "foreign";
  const duplicate = await exchange(client, `${base}/contents/generations/tasks`, "POST", "{}");
  assert.throws(() => matcher.capture(client, duplicate), /identity/);
  assert.equal(matcher.getRemoteDescriptor({ type: "video", contentBytes: bytes }, 0), undefined, "identity conflict must remain latched");
});

test("Comfy download matcher applies original output rules and exact api/view query, never arbitrary output nodes", async t => {
  api(); const bytes = Buffer.from("comfy-image"); let base;
  base = await server(t, (req, res) => req.method === "POST" ? json(res, { prompt_id: "exact" })
    : req.url === "/api/jobs/exact" ? json(res, { id: "exact", status: "completed", outputs: { chosen: { images: [{ filename: "chosen.png", subfolder: "folder", type: "output" }] }, ignored: { images: [{ filename: "foreign.png" }] } } })
    : (res.writeHead(200, { "content-type": "image/png" }), res.end(bytes)));
  const client = await native(), scope = plan("comfy_jobs_v1", `${base}/ignored`, [{ nodeId: "chosen", artifactType: "image", collect: "first" }]);
  const matcher = api().createMediaNativeRemoteDescriptorMatcher(scope);
  matcher.capture(client, await exchange(client, `${base}/api/prompt`, "POST", "{}")); matcher.capture(client, await exchange(client, scope.statusRoute("exact").url));
  matcher.capture(client, await exchange(client, `${base}/api/view?filename=foreign.png`)); assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes }, 0), undefined);
  matcher.capture(client, await exchange(client, `${base}/api/view?filename=chosen.png&subfolder=folder&type=output`));
  assert.equal(matcher.getRemoteDescriptor({ type: "image", contentBytes: bytes, pathHint: "chosen.png" }, 0).pathHint, "chosen.png");
});
