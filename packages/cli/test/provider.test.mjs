import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const provider = {
  id: "provider_local",
  kind: "openai-compatible",
  displayName: "Local Relay",
  providerId: "local-relay",
  model: "dpv4",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKeyRef: "env:LOCAL_RELAY_API_KEY",
  apiKeyConfigured: true,
  headers: {},
  authHeader: true,
  reasoning: true,
  input: ["text"],
  compat: {},
  capabilities: ["chat", "tool_call"],
  enabled: true,
  lastCheck: {
    ok: false,
    code: "auth_failed",
    message: "Provider authentication failed with HTTP 401.",
    checkedAt: "2026-05-21T00:00:00.000Z",
  },
  createdAt: "2026-05-21T00:00:00.000Z",
  updatedAt: "2026-05-21T00:00:00.000Z",
};
const mediaProvider = {
  ...provider,
  id: "provider_media",
  kind: "jimeng",
  displayName: "Jimeng Image",
  providerId: "jimeng",
  model: "jimeng-image",
  api: "media-job",
  apiKeyConfigured: false,
  capabilities: ["image_generate"],
  lastCheck: undefined,
};
const codexProvider = {
  ...provider,
  id: "provider_codex",
  displayName: "OpenAI Codex Responses",
  providerId: "openai-codex",
  model: "gpt-5.5-codex",
  api: "openai-codex-responses",
  providerTransport: "websocket-cached",
  baseUrl: "https://chatgpt.com/backend-api",
  apiKeyRef: "env:OPENAI_CODEX_API_KEY",
  enabled: false,
  lastCheck: {
    ok: true,
    code: "static_check",
    message: "OpenAI Codex Responses configuration is valid.",
    checkedAt: "2026-06-10T00:00:00.000Z",
  },
};

test("provider list and show include last check state", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const listResult = await runCli(daemon.url, cwd, ["provider", "list"]);

    assert.equal(listResult.code, 0, listResult.stderr);
    assert.match(listResult.stdout, /Check/);
    assert.match(listResult.stdout, /auth_failed/);

    const showResult = await runCli(daemon.url, cwd, ["provider", "show", provider.id]);

    assert.equal(showResult.code, 0, showResult.stderr);
    assert.match(showResult.stdout, /Last check: auth_failed/);
    assert.match(showResult.stdout, /Checked: 2026-05-21T00:00:00.000Z/);
    assert.match(showResult.stdout, /Check message: Provider authentication failed with HTTP 401\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("provider list and show include provider transport", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-transport-"));
  try {
    const listResult = await runCli(daemon.url, cwd, ["provider", "list"]);

    assert.equal(listResult.code, 0, listResult.stderr);
    assert.match(listResult.stdout, /Transport/);
    assert.match(listResult.stdout, /websocket-cached/);

    const showResult = await runCli(daemon.url, cwd, ["provider", "show", codexProvider.id]);

    assert.equal(showResult.code, 0, showResult.stderr);
    assert.match(showResult.stdout, /API: openai-codex-responses/);
    assert.match(showResult.stdout, /Transport: websocket-cached/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("provider add and update send provider transport fields", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-transport-"));
  try {
    const addResult = await runCli(daemon.url, cwd, [
      "provider",
      "add",
      "openai",
      "--name",
      "OpenAI Codex Responses",
      "--provider-id",
      "openai-codex",
      "--model",
      "gpt-5.5-codex",
      "--api",
      "openai-codex-responses",
      "--provider-transport",
      "websocket",
      "--base-url",
      "https://chatgpt.com/backend-api",
      "--api-key-ref",
      "env:OPENAI_CODEX_API_KEY",
    ]);

    assert.equal(addResult.code, 0, addResult.stderr);
    assert.equal(daemon.providerRequests.length, 1);
    assert.equal(daemon.providerRequests[0].method, "POST");
    assert.equal(daemon.providerRequests[0].body.api, "openai-codex-responses");
    assert.equal(daemon.providerRequests[0].body.providerTransport, "websocket");

    const updateResult = await runCli(daemon.url, cwd, [
      "provider",
      "update",
      codexProvider.id,
      "--provider-transport",
      "sse",
    ]);

    assert.equal(updateResult.code, 0, updateResult.stderr);
    assert.equal(daemon.providerRequests.length, 2);
    assert.equal(daemon.providerRequests[1].method, "PATCH");
    assert.equal(daemon.providerRequests[1].body.providerTransport, "sse");

    const clearResult = await runCli(daemon.url, cwd, [
      "provider",
      "update",
      codexProvider.id,
      "--clear-provider-transport",
    ]);

    assert.equal(clearResult.code, 0, clearResult.stderr);
    assert.equal(daemon.providerRequests.length, 3);
    assert.equal(daemon.providerRequests[2].body.providerTransport, null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("provider check-all checks enabled chat providers", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const result = await runCli(daemon.url, cwd, ["provider", "check-all"]);

    assert.equal(result.code, 4);
    assert.match(result.stdout, /provider_local/);
    assert.match(result.stdout, /auth_failed/);
    assert.match(result.stdout, /Checked 1 chat providers: 0 ready, 1 failed\./);
    assert.deepEqual(daemon.checkRequests, ["provider_local"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run blocks providers without successful preflight", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const result = await runCli(daemon.url, cwd, ["run", "--provider", provider.id, "--prompt", "hello"]);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /provider_preflight_failed/);
    assert.match(result.stderr, /provider check failed \(auth_failed\)/);
    assert.deepEqual(daemon.runRequests, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("task run blocks providers without successful preflight", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const result = await runCli(daemon.url, cwd, ["task", "run", "task_1", "--provider", provider.id]);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /provider_preflight_failed/);
    assert.match(result.stderr, /provider check failed \(auth_failed\)/);
    assert.deepEqual(daemon.runRequests, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run can skip provider preflight", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const result = await runCli(daemon.url, cwd, ["run", "--provider", provider.id, "--skip-preflight", "--prompt", "hello"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Run: run_1/);
    assert.equal(daemon.runRequests.length, 1);
    assert.equal(daemon.runRequests[0].providerPresetId, provider.id);
    assert.equal(daemon.runRequests[0].skipProviderPreflight, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("task run can skip provider preflight", async () => {
  const daemon = await startProviderDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-provider-"));
  try {
    const result = await runCli(daemon.url, cwd, ["task", "run", "task_1", "--provider", provider.id, "--skip-preflight"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Run: run_1/);
    assert.equal(daemon.runRequests.length, 1);
    assert.equal(daemon.runRequests[0].providerPresetId, provider.id);
    assert.equal(daemon.runRequests[0].skipProviderPreflight, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

function runCli(daemonUrl, cwd, args) {
  return new Promise((resolveResult) => {
    const child = execFile(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
    child.stdin?.end();
  });
}

async function startProviderDaemon() {
  const checkRequests = [];
  const runRequests = [];
  const providerRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/runs") {
      runRequests.push(await readJsonBody(request));
      writeSseReady(response, "run_1");
      return;
    }

    if (!url.searchParams.get("cwd")) {
      writeJson(response, 400, { error: "bad_request" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), providers: [provider, mediaProvider, codexProvider] });
      return;
    }

    if (request.method === "GET" && url.pathname === `/providers/${provider.id}`) {
      writeJson(response, 200, { provider });
      return;
    }

    if (request.method === "GET" && url.pathname === `/providers/${codexProvider.id}`) {
      writeJson(response, 200, { provider: codexProvider });
      return;
    }

    if (request.method === "POST" && url.pathname === "/providers") {
      const body = await readJsonBody(request);
      providerRequests.push({ method: "POST", body });
      writeJson(response, 200, { provider: { ...codexProvider, id: "provider_created", ...body } });
      return;
    }

    if (request.method === "PATCH" && url.pathname === `/providers/${codexProvider.id}`) {
      const body = await readJsonBody(request);
      providerRequests.push({ method: "PATCH", body });
      writeJson(response, 200, { provider: { ...codexProvider, ...body } });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tasks/task_1") {
      writeJson(response, 200, {
        task: {
          id: "task_1",
          channelId: "channel_1",
          title: "Task 1",
          prompt: "Do task 1",
          status: "todo",
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/channels/channel_1") {
      writeJson(response, 200, {
        channel: {
          id: "channel_1",
          name: "Default",
          boundPath: "/tmp/project",
          allowedTools: ["read", "grep"],
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === `/providers/${provider.id}/check`) {
      checkRequests.push(provider.id);
      writeJson(response, 200, {
        ok: false,
        code: "auth_failed",
        message: "Provider authentication failed with HTTP 401.",
        checkedAt: "2026-05-21T00:01:00.000Z",
      });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    checkRequests,
    runRequests,
    providerRequests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolveRequestBody, rejectRequestBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", rejectRequestBody);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      resolveRequestBody(text ? JSON.parse(text) : {});
    });
  });
}

function writeSseReady(response, runId) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`event: ready\ndata: ${JSON.stringify({ runId })}\n\n`);
}
