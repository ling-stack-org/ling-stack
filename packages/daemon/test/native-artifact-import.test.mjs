import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile, readdir } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { imageFixture, assertFreshPng, assertPixelsClose, orientedImages, orientedExpectedPixels } from "./support/native-image-fixtures.mjs";
import { materializeNativeArtifacts } from "../dist/runtime/adapters/native-artifact-import.js";
import { nativeArtifactIdentity } from "../../core/dist/index.js";
import { readNativeArtifactContent } from "../dist/runtime/adapters/native-artifact-files.js";
import { buildArtifactPreview } from "../dist/features/previews/content-preview.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ling-native-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, submissionId: "owned-submission", signal: new AbortController().signal };
}
const event = content => ({ type: "tool_end", data: { toolCallId: "image-1", toolName: "image_generation", isError: false,
  result: { content } } });
const picture = bytes => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
const png = () => imageFixture("png");

test("text materialization takes live secrets after asynchronous image processing", async t => {
  const secretRegistry = new NativeSecretRegistry(["old-credential"]);
  const options = { ...await fixture(t), extraSecrets: ["static-credential"], secretRegistry };
  const content = [picture(await png()), { type: "resource", resource: { uri: "file:///never-read",
    text: "old-credential rotated-credential static-credential" } }];
  const pending = materializeNativeArtifacts([event(content)], options);
  secretRegistry.register(["rotated-credential"]);
  const result = await pending;
  const text = result.artifacts.find(artifact => artifact.kind === "text");
  const identity = nativeArtifactIdentity(options.directory, options.submissionId, text);
  const bytes = await readFile(identity.path);
  assert.equal(bytes.toString(), "[REDACTED] [REDACTED] [REDACTED]");
  assert.equal(text.sizeBytes, bytes.length);
  assert.equal(content[1].resource.text, "old-credential rotated-credential static-credential", "Native input is never rewritten");
});

test("returned image pixels become owned metadata-stripped PNG artifacts and replay without overwrite", async t => {
  const options = await fixture(t);
  const bytes = await png();
  const events = [event([picture(bytes)])];
  const result = await materializeNativeArtifacts(events, options);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.events[0].data.result.content[0].type, "resource_link");
  assert.equal(events[0].data.result.content[0].type, "image");
  const identity = nativeArtifactIdentity(options.directory, options.submissionId, result.artifacts[0]);
  const output = await readFile(identity.path);
  const metadata = assertFreshPng(output);
  assert.equal(metadata.width, 3);
  assert.equal(metadata.height, 2);
  const raw = metadata.data;
  assertPixelsClose(raw.subarray(0, 4), [224, 59, 82, 255], 1, "sRGB reference");
  assert.deepEqual(await materializeNativeArtifacts(events, options), result);
  await writeFile(identity.path, "conflict");
  await assert.rejects(materializeNativeArtifacts(events, options), { code: "artifact_conflict" });
  await unlink(identity.path);
  await symlink(join(options.directory, "absent"), identity.path);
  await assert.rejects(materializeNativeArtifacts(events, options), { code: "artifact_conflict" });
});

test("embedded text is redacted before publication while path and network references are never read", async t => {
  const options = { ...await fixture(t), extraSecrets: ["owned secret"] };
  const reference = { type: "resource_link", uri: "https://127.0.0.1:1/private", name: "remote" };
  const result = await materializeNativeArtifacts([event([
    { type: "resource", resource: { uri: "file:///untrusted/secret", text: "owned secret and Bearer abc", mimeType: "text/html" } }, reference,
  ])], options);
  const identity = nativeArtifactIdentity(options.directory, options.submissionId, result.artifacts[0]);
  assert.equal(await readFile(identity.path, "utf8"), "[REDACTED] and [REDACTED]");
  assert.equal(identity.contentType, "text/plain; charset=utf-8");
  assert.deepEqual(result.events[0].data.result.content[1], reference);
  assert.equal(JSON.stringify(result).includes("owned secret"), false);
  const artifact = { id: identity.id, path: identity.path, type: "file", contentType: identity.contentType,
    sizeBytes: result.artifacts[0].sizeBytes, createdAt: "2026-09-09T00:00:00.000Z",
    sealedPayload: { nativeArtifact: { version: 1, submissionId: options.submissionId, toolCallId: "image-1",
      byteSha256: result.artifacts[0].sha256 } } };
  const content = readNativeArtifactContent(options.directory, artifact);
  await unlink(identity.path);
  const preview = buildArtifactPreview({ artifact, contentPath: identity.path, content });
  assert.equal(preview.text, "[REDACTED] and [REDACTED]");
  assert.equal(preview.kind, "plain_text");
});

test("assistant byte imports use a separate namespace and serving rejects stripped or substituted provenance", async t => {
  const options = await fixture(t);
  const content = [{ type: "resource", resource: { uri: "file:///never-read", text: "Owned report" } }];
  const result = await materializeNativeArtifacts([event(content), { type: "progress", data: {
    nativeKind: "assistant_content", role: "assistant", itemId: "image-1", content,
  } }], options);
  assert.equal(result.artifacts.length, 2);
  const descriptor = result.artifacts[1];
  assert.equal(descriptor.sourceKind, "assistant");
  const identity = nativeArtifactIdentity(options.directory, options.submissionId, descriptor);
  assert.notEqual(identity.id, nativeArtifactIdentity(options.directory, options.submissionId, result.artifacts[0]).id);
  const native = { version: 1, submissionId: options.submissionId, toolCallId: descriptor.toolCallId,
    sourceKind: "assistant", byteSha256: descriptor.sha256 };
  const artifact = { id: identity.id, path: identity.path, type: "file", contentType: identity.contentType,
    sizeBytes: descriptor.sizeBytes, createdAt: "2026-09-09T00:00:00.000Z", sealedPayload: { nativeArtifact: native } };
  assert.equal(readNativeArtifactContent(options.directory, artifact).toString(), "Owned report");
  for (const sourceKind of [undefined, null, "tool", "unknown"]) assert.throws(() => readNativeArtifactContent(options.directory, {
    ...artifact, sealedPayload: { nativeArtifact: { ...native, sourceKind } },
  }), { code: "artifact_conflict" });
});

test("invalid bytes, deceptive MIME, pixel limits and cancellation publish nothing", async t => {
  const options = await fixture(t);
  for (const block of [picture(Buffer.from("not a PNG")), { ...picture(await png()), mimeType: "image/jpeg" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U==!" }]) {
    await assert.rejects(materializeNativeArtifacts([event([block])], options), { code: "invalid_artifact" });
  }
  await assert.rejects(materializeNativeArtifacts([event([picture(await png())])], { ...options, maxPixels: 5 }), { code: "capacity_exceeded" });
  await assert.rejects(materializeNativeArtifacts([event([picture(await png())])], { ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(await readdir(options.directory), []);
});

test("animation and damaged pixel data never silently become a first-frame or repaired artifact", async t => {
  const options = await fixture(t);
  const source = await png();
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write("acTL", 4);
  animation.writeUInt32BE(2, 8);
  animation.writeUInt32BE(crc32(animation.subarray(4, 16)), 16);
  const apng = Buffer.concat([source.subarray(0, 33), animation, source.subarray(33)]);
  await assert.rejects(materializeNativeArtifacts([event([picture(apng)])], options), { code: "unsupported_artifact" });
  const corrupt = Buffer.from(source);
  const idat = corrupt.indexOf(Buffer.from("IDAT"));
  corrupt[idat + 5] ^= 0xff;
  await assert.rejects(materializeNativeArtifacts([event([picture(corrupt)])], options), { code: "invalid_artifact" });
  assert.deepEqual(await readdir(options.directory), []);
});

test("cancellation during decoding settles promptly and does not publish a file", { timeout: 3000 }, async t => {
  const options = await fixture(t);
  const abort = new AbortController();
  const promise = materializeNativeArtifacts([event([picture(await png())])], { ...options, signal: abort.signal });
  abort.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.deepEqual(await readdir(options.directory), []);
});

test("a substituted artifact directory is rejected without writing to its target", async t => {
  const options = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "ling-native-artifact-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(options.directory, "native"));
  await assert.rejects(materializeNativeArtifacts([event([picture(await png())])], options), { code: "artifact_conflict" });
  assert.deepEqual(await readdir(outside), []);
});

test("JPEG and WebP pixels are decoded into PNG, not saved with a deceptive extension", async t => {
  const options = await fixture(t);
  for (const format of ["jpeg", "webp"]) {
    const bytes = imageFixture(format);
    const result = await materializeNativeArtifacts([event([{ type: "image", mimeType: `image/${format}`, data: bytes.toString("base64") }])], options);
    const identity = nativeArtifactIdentity(options.directory, options.submissionId, result.artifacts[0]);
    assertFreshPng(await readFile(identity.path));
  }
});

test("all eight EXIF orientations retain PNG and WebP pixels while removing source metadata", async t => {
  const options = await fixture(t);
  for (const format of ["png", "webp"]) for (let orientation = 1; orientation <= 8; orientation++) {
    const result = await materializeNativeArtifacts([event([{ type: "image", mimeType: `image/${format}`,
      data: orientedImages[format][orientation] }])], { ...options, submissionId: `${format}-${orientation}` });
    const output = await readFile(nativeArtifactIdentity(options.directory, `${format}-${orientation}`, result.artifacts[0]).path);
    const decoded = assertFreshPng(output), expected = orientedExpectedPixels[format][orientation];
    assert.equal(decoded.width, expected.width);
    assert.equal(decoded.height, expected.height);
    assertPixelsClose(decoded.data, expected.data, 1, `${format} orientation ${orientation}`);
  }
});

test("JPEG orientation and ICC colors survive real artifact materialization against independent golden pixels", async t => {
  const options = await fixture(t);
  const golden = JSON.parse(await readFile(new URL("fixtures/native-image-color-golden.json", import.meta.url), "utf8"));
  for (const sample of golden.cases) {
    const input = Buffer.from(sample.inputBase64, "base64");
    const submissionId = `color-${sample.name}`;
    const result = await materializeNativeArtifacts([event([{ type: "image", mimeType: `image/${sample.format === "jpg" ? "jpeg" : sample.format}`,
      data: input.toString("base64") }])], { ...options, submissionId });
    const output = await readFile(nativeArtifactIdentity(options.directory, submissionId, result.artifacts[0]).path);
    const decoded = assertFreshPng(output), expected = sample.expected;
    assert.equal(decoded.width, expected.width, sample.name);
    assert.equal(decoded.height, expected.height, sample.name);
    assert.equal(decoded.data.length, expected.data.length, sample.name);
    const delta = Math.max(...decoded.data.map((value, index) => Math.abs(value - expected.data[index])));
    assert.ok(delta <= sample.maxDelta, `${sample.name}: max channel delta ${delta} exceeds ${sample.maxDelta}`);
    assertPixelsClose(decoded.data, expected.data, sample.maxDelta, sample.name);
  }
});
