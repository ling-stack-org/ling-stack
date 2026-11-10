import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Agents can verify an isolated outDir without rewriting the shared providers build.
const moduleUrl = process.env.LING_SEEDANCE_TEST_BUILD_DIR
  ? pathToFileURL(`${process.env.LING_SEEDANCE_TEST_BUILD_DIR}/vendors/seedance.js`)
  : new URL("../dist/vendors/seedance.js", import.meta.url);
const {
  cancelSeedanceVideoTask,
  executeSeedanceVideoTask,
  pollSeedanceVideoTask,
  submitSeedanceVideoTask,
} = await import(moduleUrl.href);
const { decodeSeedanceTaskStatusResponse } = await import(new URL("./seedance-task-status.js", moduleUrl).href);

const baseUrl = "https://seedance.example.invalid/api/v3";
const taskId = "task_current";
const statusEndpoint = `${baseUrl}/contents/generations/tasks/${taskId}`;
const videoUrl = "https://seedance.example.invalid/outputs/final.mp4";
const videoBytes = Uint8Array.of(1, 2, 3, 4);

function handle(overrides = {}) {
  return {
    adapterKind: "seedance",
    externalOperationId: taskId,
    recovery: { statusEndpoint, requestSummary: { model: "seedance" } },
    ...overrides,
  };
}

function options(httpClient, overrides = {}) {
  return { baseUrl, apiKey: "test-key", pollIntervalMs: 0, maxPollAttempts: 3, httpClient, ...overrides };
}

function request() {
  return {
    vendor: { kind: "seedance" },
    requestPlan: {
      operation: "video_generate",
      provider: { model: "seedance" },
      payload: { prompt: "Animate a geometric shape.", input: {} },
    },
    jobId: "media_seedance_terminal_contract",
    requestedAt: "2026-10-03T00:00:00.000Z",
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: new Headers({ "content-type": "application/json" }),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

function videoResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "video/mp4" }),
    async arrayBuffer() { return videoBytes.buffer; },
  };
}

test("Seedance recovery video URL does not bypass an exact status request", async () => {
  const requests = [];
  const result = await pollSeedanceVideoTask(handle({
    recovery: { statusEndpoint, videoUrl },
  }), options(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ id: taskId, status: "running", content: { video_url: videoUrl } });
  }));

  assert.equal(result.status, "pending");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, statusEndpoint);
  assert.equal(requests[0].init.method, "GET");
});

for (const remoteStatus of ["queued", "running"]) {
  test(`Seedance ${remoteStatus} with an output URL is still pending`, async () => {
    const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
      id: taskId, status: remoteStatus, content: { video_url: videoUrl },
    })));
    assert.equal(result.status, "pending");
    assert.equal(result.recovery, undefined);
  });
}

test("Seedance output URL without an explicit terminal status is not success", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: taskId, content: { video_url: videoUrl },
  })));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
});

test("Seedance successful status for a different task is rejected", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: "task_foreign", status: "succeeded", content: { video_url: videoUrl },
  })));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
  assert.match(result.errorMessage, /identity|different task|task id/i);
});

test("Seedance exact endpoint scope does not invent a required echoed task id", async () => {
  const requests = [];
  const result = await pollSeedanceVideoTask(handle(), options(async (url) => {
    requests.push(url);
    return jsonResponse({ status: "succeeded", content: { video_url: videoUrl } });
  }));
  assert.deepEqual(requests, [statusEndpoint]);
  assert.equal(result.status, "succeeded");
  assert.equal(result.recovery.videoUrl, videoUrl);
});

test("Seedance canonical task response may have a single data envelope", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    data: { id: taskId, status: "succeeded", content: { video_url: videoUrl } },
  })));
  assert.equal(result.status, "succeeded");
  assert.equal(result.recovery.videoUrl, videoUrl);
});

test("Seedance cannot combine the current id with a foreign data task", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: taskId,
    data: { id: "task_foreign", status: "succeeded", content: { video_url: videoUrl } },
  })));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
});

test("Seedance cannot combine a pending task with a nested completed task", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: taskId,
    status: "running",
    task: { id: "task_foreign", status: "succeeded", content: { video_url: videoUrl } },
  })));
  assert.notEqual(result.status, "succeeded");
});

for (const remoteStatus of ["success", "completed", "done", "cancelled", "error"]) {
  test(`Seedance unverified status alias ${remoteStatus} does not become terminal success`, async () => {
    const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
      id: taskId, status: remoteStatus, content: { video_url: videoUrl },
    })));
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "invalid_request");
  });
}

test("Seedance generic URL or nested output is not the canonical video result", async () => {
  for (const body of [
    { id: taskId, status: "succeeded", url: videoUrl },
    { id: taskId, status: "succeeded", output: { video_url: videoUrl } },
  ]) {
    const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse(body)));
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "media_result_unavailable");
  }
});

test("Seedance explicit succeeded without a video retains remote terminal fact, not output success", async () => {
  const body = { id: taskId, status: "succeeded" };
  const observation = decodeSeedanceTaskStatusResponse(body, taskId);
  assert.equal(observation.status, "succeeded");
  assert.equal(observation.videoUrl, undefined);
  assert.deepEqual(observation.terminal, {
    protocol: "seedance_task_v1",
    externalOperationId: taskId,
    identitySource: "echoed_id",
    rawStatus: "succeeded",
    outcome: "completed",
  });
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse(body)));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "media_result_unavailable");
  assert.equal(result.recovery, undefined);
});

test("Seedance exact failed task cannot be upgraded by an output URL", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: taskId, status: "failed", content: { video_url: videoUrl },
  })));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "provider_internal_error");
});

test("Seedance mismatched persisted status endpoint sends no request", async () => {
  let requests = 0;
  const result = await pollSeedanceVideoTask(handle({
    recovery: { statusEndpoint: `${baseUrl}/contents/generations/tasks/task_foreign` },
  }), options(async () => {
    requests += 1;
    return jsonResponse({ id: taskId, status: "succeeded", content: { video_url: videoUrl } });
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
  assert.equal(requests, 0);
});

test("Seedance handle cannot be observed under a changed provider namespace", async () => {
  let requests = 0;
  const result = await pollSeedanceVideoTask(handle(), options(async () => {
    requests += 1;
    return jsonResponse({ id: taskId, status: "succeeded", content: { video_url: videoUrl } });
  }, { baseUrl: "https://other-seedance.example.invalid/api/v3" }));
  assert.equal(result.status, "failed");
  assert.equal(requests, 0);
});

test("Seedance empty external task identity sends no request", async () => {
  let requests = 0;
  const result = await pollSeedanceVideoTask(handle({ externalOperationId: " " }), options(async () => {
    requests += 1;
    return jsonResponse({ status: "succeeded", content: { video_url: videoUrl } });
  }));
  assert.equal(result.status, "failed");
  assert.equal(requests, 0);
});

test("Seedance opaque task ids remain percent encoded in the exact route", async () => {
  const externalOperationId = "task/a?b#c";
  const endpoint = `${baseUrl}/contents/generations/tasks/${encodeURIComponent(externalOperationId)}`;
  const requests = [];
  const result = await pollSeedanceVideoTask(handle({
    externalOperationId, recovery: { statusEndpoint: endpoint },
  }), options(async (url) => {
    requests.push(url);
    return jsonResponse({ id: externalOperationId, status: "succeeded", content: { video_url: videoUrl } });
  }));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requests, [endpoint]);
});

test("Seedance 404 is an observation failure, not a successful or cancelled task", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => jsonResponse({
    id: taskId, status: "succeeded", content: { video_url: videoUrl },
  }, 404)));
  assert.equal(result.status, "failed");
  assert.equal(result.recovery, undefined);
});

test("Seedance rejected status request does not return a terminal result", async () => {
  const result = await pollSeedanceVideoTask(handle(), options(async () => {
    throw new Error("status transport disconnected");
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "network_error");
  assert.equal(result.recovery, undefined);
});

test("Seedance submission does not store an unverified create-response video URL", async () => {
  const result = await submitSeedanceVideoTask(request(), options(async () => jsonResponse({
    id: taskId, status: "running", content: { video_url: videoUrl },
  })));
  assert.equal(result.status, "submitted");
  assert.equal(result.handle.recovery.videoUrl, undefined);
});

test("Seedance direct execution always polls after a create response containing a URL", async () => {
  const requests = [];
  const result = await executeSeedanceVideoTask(request(), options(async (url, init) => {
    requests.push({ url, method: init.method });
    if (init.method === "POST") {
      return jsonResponse({ id: taskId, status: "running", content: { video_url: videoUrl } });
    }
    if (url === statusEndpoint) {
      return jsonResponse({ id: taskId, status: "succeeded", content: { video_url: videoUrl } });
    }
    assert.equal(url, videoUrl);
    return videoResponse();
  }));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(requests.map(({ url }) => url), [
    `${baseUrl}/contents/generations/tasks`, statusEndpoint, videoUrl,
  ]);
});

test("Seedance direct execution waits past pending URL before downloading final result", async () => {
  const requests = [];
  let polls = 0;
  const result = await executeSeedanceVideoTask(request(), options(async (url, init) => {
    requests.push({ url, method: init.method });
    if (init.method === "POST") return jsonResponse({ id: taskId });
    if (url === statusEndpoint) {
      polls += 1;
      return jsonResponse({
        id: taskId, status: polls === 1 ? "running" : "succeeded", content: { video_url: videoUrl },
      });
    }
    assert.equal(url, videoUrl);
    return videoResponse();
  }));
  assert.equal(result.status, "succeeded");
  assert.equal(polls, 2);
  assert.equal(requests.length, 4);
});

test("Seedance direct execution rejects foreign terminal identity without download", async () => {
  const requests = [];
  const result = await executeSeedanceVideoTask(request(), options(async (url, init) => {
    requests.push(url);
    if (init.method === "POST") return jsonResponse({ id: taskId });
    if (url === statusEndpoint) {
      return jsonResponse({ id: "task_foreign", status: "succeeded", content: { video_url: videoUrl } });
    }
    return videoResponse();
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
  assert.equal(requests.includes(videoUrl), false);
});

test("Seedance cancellation stays a no-op without claiming a remote stop", async () => {
  assert.equal(await cancelSeedanceVideoTask(handle()), undefined);
});
