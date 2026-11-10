import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadTestsavantFile, testsavantPin, validateTestsavantPin } from "./collect-testsavant-model.mjs";

test("TestSavant pin preserves original FP32 weights, immutable revision and unresolved release authorization", () => {
  assert.equal(validateTestsavantPin(testsavantPin), 116117227);
  for (const change of [p => { p.revision = "main"; }, p => { p.releaseEligible = true; },
    p => { p.files[0].path = "../config.json"; }, p => { p.files[5].remotePath = "other.onnx"; },
    p => { p.files[0].sizeBytes = 256 * 1024 ** 2; }]) {
    const pin = structuredClone(testsavantPin); change(pin);
    assert.throws(() => validateTestsavantPin(pin), /pin_invalid/);
  }
});

test("bounded TestSavant acquisition checks hashes, redirects, inventory identity and no-overwrite", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-testsavant-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = testsavantPin.files[0], bytes = await readFile(new URL("./testsavant-model-pin.json", import.meta.url));
  for (const [i, request] of [
    async () => new Response(Buffer.alloc(file.sizeBytes)),
    async () => new Response(bytes),
    async () => new Response(null, { status: 403 }),
    async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/steal" } }),
    async () => new Response(null, { status: 302, headers: { location: "https://huggingface.co/loop" } }),
    async () => new Response(new ReadableStream({ start(c) { c.error(new Error("abort")); } })),
  ].entries()) {
    const destination = join(root, `${i}`);
    await assert.rejects(downloadTestsavantFile(file, destination, request));
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
  const destination = join(root, "existing");
  await writeFile(destination, "keep");
  await assert.rejects(downloadTestsavantFile(file, destination, async () => new Response(Buffer.alloc(file.sizeBytes))));
  assert.equal(await readFile(destination, "utf8"), "keep");
  await assert.rejects(downloadTestsavantFile({ ...file, path: "../escape" }, destination), /file_unpinned/);
});
