import assert from "node:assert/strict";
import test from "node:test";
import { createLingStackMediaGenerationExtension } from "../dist/extensions/media-generation.js";

test("media generation extension registers only configured tools and forwards safe input", async () => {
  const registered = [];
  const requests = [];
  createLingStackMediaGenerationExtension({
    ...baseOptions(),
    runId: "run_media",
    mediaGenerationTools: [{
      name: "image_generate",
      targets: [{
        id: "provider:image",
        displayName: "Studio Image",
        aspectRatios: ["1:1", "16:9"],
        supportsAspectRatio: true,
        supportsCount: true,
      }],
    }],
    async onMediaGenerationToolCall(request) {
      requests.push(request);
      return {
        content: [{ type: "text", text: "Image generation started." }],
        details: { mediaJobId: "media_job_1", status: "queued" },
      };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "image_generate");
  assert.match(registered[0].description, /Studio Image \(provider:image; prompt, aspectRatio=1:1\|16:9, count=1\.\.4\)/);
  assert.ok(registered[0].parameters.properties.aspectRatio);
  assert.ok(registered[0].parameters.properties.count);
  assert.equal(registered[0].parameters.properties.durationSeconds, undefined);

  const controller = new AbortController();
  const result = await registered[0].execute("tool_media", {
    prompt: "  a paper-cut city  ",
    target: " Studio Image ",
    aspectRatio: "16:9",
    count: 2,
  }, controller.signal);

  assert.deepEqual(result.content, [{ type: "text", text: "Image generation started." }]);
  assert.deepEqual(result.details, { mediaJobId: "media_job_1", status: "queued" });
  assert.equal(requests.length, 1);
  assert.deepEqual({
    toolCallId: requests[0].toolCallId,
    toolName: requests[0].toolName,
    runId: requests[0].runId,
    prompt: requests[0].prompt,
    target: requests[0].target,
    aspectRatio: requests[0].aspectRatio,
    count: requests[0].count,
  }, {
    toolCallId: "tool_media",
    toolName: "image_generate",
    runId: "run_media",
    prompt: "a paper-cut city",
    target: "Studio Image",
    aspectRatio: "16:9",
    count: 2,
  });
  assert.equal(requests[0].signal, controller.signal);
});

test("media generation extension omits empty tools and requires a daemon handler", () => {
  const registered = [];
  createLingStackMediaGenerationExtension({
    ...baseOptions(),
    runId: "run_media",
    mediaGenerationTools: [
      { name: "image_generate", targets: [] },
      { name: "video_generate", targets: [{ id: "workflow:video", displayName: "Video Flow" }] },
    ],
  })({ on() {}, registerTool: (tool) => registered.push(tool) });
  assert.equal(registered.length, 0);
});

test("media schema may be prepared without a Run but cannot execute without its owner", async () => {
  const registered = [];
  let calls = 0;
  createLingStackMediaGenerationExtension({ ...baseOptions(),
    mediaGenerationTools: [{ name: "image_generate", targets: [{ id: "fixture", displayName: "Fixture" }] }],
    onMediaGenerationToolCall: async () => { calls += 1; return { content: [] }; },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });
  assert.equal(registered.length, 1);
  await assert.rejects(registered[0].execute("fixture_call", { prompt: "fixture" }), /not connected for this run/);
  assert.equal(calls, 0);
});

test("media generation schema omits options unsupported by every target", () => {
  const registered = [];
  createLingStackMediaGenerationExtension({
    ...baseOptions(),
    runId: "run_media",
    mediaGenerationTools: [{
      name: "video_generate",
      targets: [{ id: "workflow:video", displayName: "Prompt-only Video Flow" }],
    }],
    async onMediaGenerationToolCall() {
      return { content: [{ type: "text", text: "accepted" }] };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  assert.equal(registered.length, 1);
  assert.match(registered[0].description, /Prompt-only Video Flow \(workflow:video; prompt\)/);
  assert.equal(registered[0].parameters.properties.aspectRatio, undefined);
  assert.equal(registered[0].parameters.properties.durationSeconds, undefined);
  assert.equal(registered[0].parameters.properties.count, undefined);
});

test("media generation extension rejects invalid controlled input", async () => {
  const registered = [];
  createLingStackMediaGenerationExtension({
    ...baseOptions(),
    runId: "run_media",
    mediaGenerationTools: [{
      name: "image_generate",
      targets: [{ id: "provider:image", displayName: "Studio Image" }],
    }],
    async onMediaGenerationToolCall() {
      throw new Error("must not be called");
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_invalid", { prompt: "draw", count: 5 }),
    /count must be between 1 and 4/,
  );
});

test("media generation extension discards a late result after runner cancellation", async () => {
  const registered = [];
  const controller = new AbortController();
  const abortReason = new Error("cancelled during media creation");
  createLingStackMediaGenerationExtension({
    ...baseOptions(),
    runId: "run_media",
    mediaGenerationTools: [{
      name: "video_generate",
      targets: [{ id: "provider:video", displayName: "Studio Video" }],
    }],
    async onMediaGenerationToolCall() {
      controller.abort(abortReason);
      return { content: [{ type: "text", text: "late" }] };
    },
  })({ on() {}, registerTool: (tool) => registered.push(tool) });

  await assert.rejects(
    registered[0].execute("tool_cancelled", { prompt: "animate", durationSeconds: 5 }, controller.signal),
    (error) => error === abortReason,
  );
});

function baseOptions() {
  return {
    cwd: "/tmp/ling-media-generation",
    task: { id: "task_media", title: "Generate media", prompt: "Make an asset" },
    provider: { provider: "test", model: "test" },
  };
}
