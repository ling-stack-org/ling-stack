import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type {
  LiveMediaVendorTransportOptions,
  MediaExecutionArtifact,
  MediaVendorHttpClient,
  MediaVendorHttpRequestInit,
  MediaVendorHttpResponse,
  MediaVendorTransportRequest,
} from "../dist/index.js";
import type { SeedanceTerminalObservation } from "../dist/vendors/seedance-task-status.js";

const build = process.env.LING_MEDIA_RESULT_BUILD_DIR;
const moduleUrl = build ? pathToFileURL(`${build}/index.js`) : new URL("../dist/index.js", import.meta.url);
const { createStaticVendorMediaAdapterFactory, executeMediaJob } = await import(moduleUrl.href) as typeof import("../dist/index.js");
const { collectSeedanceVideoArtifacts, executeSeedanceVideoTask, pollSeedanceVideoTask } =
  await import(new URL("./vendors/seedance.js", moduleUrl).href) as typeof import("../dist/vendors/seedance.js");

const baseUrl = "https://seedance.example.invalid/api/v3";
const externalOperationId = "result_task";
const statusEndpoint = `${baseUrl}/contents/generations/tasks/${externalOperationId}`;
const videoUrl = "https://seedance.example.invalid/output.mp4";
const terminal = (rawStatus: "succeeded" | "failed"): SeedanceTerminalObservation => ({ protocol: "seedance_task_v1", externalOperationId,
  identitySource: "echoed_id", rawStatus, outcome: rawStatus === "succeeded" ? "completed" : "failed" });
const handle = () => ({ adapterKind: "seedance", externalOperationId, recovery: { statusEndpoint } });
const options = (httpClient: MediaVendorHttpClient): LiveMediaVendorTransportOptions => ({
  baseUrl, apiKey: "fixture-key", apiKeyConfigured: true, httpClient, pollIntervalMs: 0, maxPollAttempts: 1,
});
const jsonResponse = (body: unknown, status = 200): MediaVendorHttpResponse => ({ ok: status === 200, status, statusText: "",
  headers: new Headers({ "content-type": "application/json" }),
  async json() { return body; }, async text() { return JSON.stringify(body); },
  async arrayBuffer() { return new ArrayBuffer(0); } });
const videoResponse = (): MediaVendorHttpResponse => ({ ok: true, status: 200, statusText: "",
  headers: new Headers({ "content-type": "video/mp4" }),
  async json() { throw new Error("binary response is not JSON"); },
  async text() { throw new Error("binary response is not text"); },
  async arrayBuffer() { return Uint8Array.of(1, 2).buffer; } });
const request = (): MediaVendorTransportRequest => ({
  vendor: { kind: "seedance", displayName: "Seedance", capabilities: ["video_generate"] },
  requestPlan: {
    mode: "static_vendor_request_plan",
    liveCall: false,
    vendor: "seedance",
    operation: "video_generate",
    provider: { presetId: "fixture", kind: "seedance", providerId: "seedance", model: "seedance" },
    payload: { prompt: "A shape", input: {} },
    notes: [],
  },
  jobId: "terminal_result_projection",
  requestedAt: "2026-10-04T00:00:00.000Z",
});

for (const [rawStatus, withUrl] of [["succeeded", true], ["succeeded", false], ["failed", true]] as const) {
  test(`Seedance poll retains ${rawStatus}/${withUrl} terminal independently of output availability`, async () => {
    const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
      id: externalOperationId, status: rawStatus, ...(withUrl ? { content: { video_url: videoUrl } } : {}),
    })));
    assert.equal(result.status, rawStatus === "succeeded" && withUrl ? "succeeded" : "failed");
    assert.ok(result.terminalObservation);
    assert.deepEqual(result.terminalObservation, terminal(rawStatus));
    assert.equal(Object.hasOwn(result.terminalObservation, "safe"), false);
  });
}

for (const [rawStatus, withUrl, downloadFails] of [["succeeded", true, false], ["succeeded", true, true],
  ["succeeded", false, false], ["failed", false, false]] as const) {
  test(`Seedance direct execution keeps observed ${rawStatus} after collection=${downloadFails}`, async () => {
    const requests: [string, MediaVendorHttpRequestInit["method"]][] = [];
    const result = await executeSeedanceVideoTask(request(), options(async (url, init) => {
      requests.push([url, init.method]);
      if (init.method === "POST") return jsonResponse({ id: externalOperationId });
      if (url === statusEndpoint) return jsonResponse({ id: externalOperationId, status: rawStatus,
        ...(withUrl ? { content: { video_url: videoUrl } } : {}) });
      assert.equal(url, videoUrl);
      if (downloadFails) throw new Error("fixture download interrupted");
      return videoResponse();
    }));
    assert.deepEqual(result.terminalObservation, terminal(rawStatus));
    assert.equal(result.status, rawStatus === "succeeded" && withUrl && !downloadFails ? "succeeded" : "failed");
    assert.equal(requests.length, withUrl ? 3 : 2, "projection must not add a second status request");
  });
}

test("Seedance collection keeps same-instance terminal on download failure without another poll", async () => {
  const requests: string[] = [];
  const configuration = options(async (url) => {
    requests.push(url);
    if (url === statusEndpoint) return jsonResponse({ id: externalOperationId, status: "succeeded", content: { video_url: videoUrl } });
    throw new Error("fixture download interrupted");
  });
  const poll = await pollSeedanceVideoTask(handle(), configuration);
  assert.equal(poll.status, "succeeded");
  const result = await collectSeedanceVideoArtifacts({ ...handle(), recovery: poll.recovery }, configuration);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.terminalObservation, terminal("succeeded"));
  assert.deepEqual(requests, [statusEndpoint, videoUrl]);
});

test("Seedance forged or restored recovery does not invent a fresh terminal observation", async () => {
  const configuration = options(async () => videoResponse());
  const result = await collectSeedanceVideoArtifacts({ ...handle(), recovery: {
    statusEndpoint, videoUrl, terminalObservation: terminal("succeeded"),
  } }, configuration);
  assert.equal(result.status, "succeeded");
  assert.equal(result.terminalObservation, undefined);
});

test("Seedance same-instance successful collection preserves observation with fixed request count", async () => {
  const requests: string[] = [];
  const configuration = options(async url => {
    requests.push(url);
    return url === statusEndpoint ? jsonResponse({ id: externalOperationId, status: "succeeded",
      content: { video_url: videoUrl } }) : videoResponse();
  });
  const poll = await pollSeedanceVideoTask(handle(), configuration);
  assert.equal(poll.status, "succeeded");
  const result = await collectSeedanceVideoArtifacts({ ...handle(), recovery: poll.recovery }, configuration);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.terminalObservation, terminal("succeeded"));
  assert.deepEqual(requests, [statusEndpoint, videoUrl]);
});

test("Seedance collection does not attribute a captured observation to a changed handle or URL", async () => {
  for (const mutation of ["identity", "endpoint", "url", "instance"]) {
    const configuration = options(async url => url === statusEndpoint ? jsonResponse({ id: externalOperationId,
      status: "succeeded", content: { video_url: videoUrl } }) : videoResponse());
    const poll = await pollSeedanceVideoTask(handle(), configuration);
    assert.equal(poll.status, "succeeded");
    const collectionHandle = { ...handle(), recovery: poll.recovery };
    if (mutation === "identity") collectionHandle.externalOperationId = "foreign_task";
    if (mutation === "endpoint") collectionHandle.recovery.statusEndpoint = `${baseUrl}/foreign`;
    if (mutation === "url") collectionHandle.recovery.videoUrl = "https://seedance.example.invalid/other.mp4";
    const result = await collectSeedanceVideoArtifacts(collectionHandle,
      mutation === "instance" ? { ...configuration } : configuration);
    assert.equal(result.terminalObservation, undefined);
  }
});

test("Seedance failed response body is not normalized as an empty completed HTTP body", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => ({
    ...jsonResponse({}, 404), async text() { throw new Error("fixture body interrupted"); },
  })));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "network_error");
  assert.equal(result.terminalObservation, undefined);
});

for (const status of ["succeeded", "failed"] as const) {
  test(`static vendor and media executor preserve ${status} facts and already collected artifacts`, async () => {
    const artifacts: MediaExecutionArtifact[] = [{ type: "video", title: "partial.mp4", contentBytes: Uint8Array.of(9), pathHint: "partial.mp4" }];
    const provider = {
      id: "fixture", kind: "seedance", displayName: "Fixture", providerId: "seedance", model: "seedance",
      api: "media-job", capabilities: ["video_generate"],
    } as const;
    const adapter = createStaticVendorMediaAdapterFactory("seedance", "Seedance", { transport: {
      mode: "fake", async execute() { return { status, artifacts, terminalObservation: terminal("succeeded"),
        fixturePrivateTransportField: "must-not-escape",
        ...(status === "failed" ? { errorCode: "network_error", errorMessage: "second download failed" } : {}) }; },
    } }).create(provider);
    const result = await executeMediaJob(adapter, { jobId: "partial_vendor", provider,
      operation: "video_generate", prompt: "A shape", input: {}, requestedAt: "2026-10-04T00:00:00.000Z" });
    assert.equal(result.status, status);
    assert.equal(result.artifacts.some(artifact => artifact === artifacts[0]), true);
    assert.deepEqual(result.terminalObservation, terminal("succeeded"));
    assert.equal(Object.hasOwn(result, "fixturePrivateTransportField"), false,
      "only named result fields may cross the transport boundary");
  });
}
