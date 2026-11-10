import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ComfyUiClient } from "../dist/features/media/workflows/comfyui-client.js";
import { analyzeComfyWorkflowGraph, materializeComfyWorkflowGraph } from "../dist/features/media/workflows/comfyui-graph.js";
import { createComfyUiWorkflowAdapter } from "../dist/features/media/workflows/workflow-adapter.js";
import { parseMediaWorkflowInputFields, parseMediaWorkflowOutputRules } from "../dist/features/media/workflows/workflow-request-parsers.js";

const now = "2026-07-14T02:00:00.000Z";

test("ComfyUI workflow analysis and materialization use controlled node mappings", () => {
  const graph = fixtureGraph("default prompt");
  const analysis = analyzeComfyWorkflowGraph(graph, {
    CLIPTextEncode: {},
    SaveVideo: {},
  }, now);
  assert.equal(analysis.validation.ok, true);
  assert.equal(analysis.inputFields[0].id, "1.text");
  assert.equal(analysis.inputFields[0].semantic, "prompt");
  assert.equal(analysis.outputRules[0].artifactType, "video");

  const materialized = materializeComfyWorkflowGraph(graph, analysis.inputFields, { "1.text": "new prompt" });
  assert.equal(materialized["1"].inputs.text, "new prompt");
  assert.equal(graph["1"].inputs.text, "default prompt");
});

test("ComfyUI adapter writes the scene prompt to the semantic prompt field and collects video output", async () => {
  let submittedGraph;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/prompt") {
      submittedGraph = JSON.parse(init.body).prompt;
      return jsonResponse({ prompt_id: "prompt_1" });
    }
    if (parsed.pathname === "/api/jobs/prompt_1") {
      return jsonResponse({
        id: "prompt_1", status: "completed",
        outputs: { "9": { videos: [{ filename: "scene.mp4", type: "output" }] } },
      });
    }
    if (parsed.pathname === "/api/view") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`Unexpected ComfyUI request: ${parsed.pathname}`);
  };
  const version = workflowVersion();
  const adapter = createComfyUiWorkflowAdapter({
    store: {},
    connection: connection({ protocolVariant: "jobs_v1", health: { ok: true, message: "ready", checkedAt: now, protocolVariant: "jobs_v1" } }),
    version,
    fetchImpl,
    resolveHostAddresses: async () => ["203.0.113.10"],
  });
  const submission = await adapter.submit({ jobId: "job_1", prompt: "scene prompt", inputValues: {}, requestedAt: now });
  assert.equal(submission.status, "submitted");
  assert.equal(submittedGraph["1"].inputs.text, "scene prompt");

  const poll = await adapter.poll(submission.handle);
  assert.equal(poll.status, "succeeded");
  const result = await adapter.collectArtifacts({ ...submission.handle, recovery: poll.recovery });
  assert.equal(result.status, "succeeded");
  assert.equal(result.artifacts[0].type, "video");
  assert.equal(result.artifacts[0].contentType, "video/mp4");
});

test("ComfyUI client blocks private addresses unless the connection is explicitly trusted", async () => {
  let requested = false;
  const client = new ComfyUiClient({
    connection: connection({ baseUrl: "http://comfy.example.test", networkPolicy: "public_only" }),
    fetchImpl: async () => {
      requested = true;
      return jsonResponse({});
    },
    resolveHostAddresses: async () => ["127.0.0.1"],
  });
  await assert.rejects(() => client.inspect(), /可信自托管连接/);
  assert.equal(requested, false);
});

test("A11 Comfy public_only uses the actual guarded native sender, not fake fetch facts", () => {
  const childEnv = { ...process.env, LING_A11_SOCKET_CASE: "comfy-native" };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=^A11 fixture child$",
    new URL("./media-native-transport.test.mjs", import.meta.url).pathname], {
    env: childEnv, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.match(result.stdout, /A11 child entered: comfy-native/, "child must execute its socket assertions");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("ComfyUI client blocks redirects and workflow mapping payloads are structurally validated", async () => {
  const client = new ComfyUiClient({
    connection: connection(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other.example/api/object_info" } }),
    resolveHostAddresses: async () => ["203.0.113.10"],
  });
  await assert.rejects(() => client.inspect(), /重定向/);

  assert.throws(() => parseMediaWorkflowInputFields([{
    id: "1.text",
    label: "提示词",
    kind: "text",
    semantic: "prompt",
    required: "yes",
    nodeId: "1",
    inputName: "text",
  }]), /必须是布尔值/);
  assert.throws(() => parseMediaWorkflowOutputRules([{ nodeId: "9", artifactType: "audio", collect: "all" }]), /image \/ video/);
});

function connection(overrides = {}) {
  return {
    id: "connection_1",
    workspaceId: "workspace_default",
    name: "ComfyUI",
    adapterKind: "comfyui",
    baseUrl: "https://comfy.example.test",
    authMode: "none",
    networkPolicy: "public_only",
    protocolVariant: "auto",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function workflowVersion() {
  return {
    id: "workflow_version_1",
    workflowDefinitionId: "workflow_1",
    version: 1,
    sourceFormat: "comfy_api_json",
    sourceDigest: "digest",
    graphSnapshot: fixtureGraph("default prompt"),
    inputFields: [{
      id: "1.text",
      label: "提示词",
      kind: "text",
      semantic: "prompt",
      required: true,
      nodeId: "1",
      inputName: "text",
    }],
    outputRules: [{ nodeId: "9", artifactType: "video", collect: "all" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: now },
    createdAt: now,
  };
}

function fixtureGraph(prompt) {
  return {
    "1": { class_type: "CLIPTextEncode", inputs: { text: prompt } },
    "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
