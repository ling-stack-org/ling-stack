import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareGstackPlatformResourceStage } from "./prepare-platform-resource-stage.mjs";

test("resource preparation requires a detached native receipt and never overwrites an existing stage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-resource-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const output = join(root, "output");
  await mkdir(input); await mkdir(output);
  await writeFile(join(output, "KEEP"), "existing resources");
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_native_receipt_required/);
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    packageSelection: "automatic-fallback", target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_package_selection_invalid/);
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    expectedNativeBuildChecksum: `sha256:${"0".repeat(64)}`, target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_output_already_exists/);
  assert.equal(await readFile(join(output, "KEEP"), "utf8"), "existing resources");
});

test("wrong receipt hashes and unaccepted native stages cannot publish or leave intermediate resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-resource-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  await mkdir(input);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source" }));
  await writeFile(join(input, "native-build.json"), bytes);
  const output = join(root, "output");
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    expectedNativeBuildChecksum: `sha256:${"0".repeat(64)}`, target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_native_receipt_mismatch/);
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    expectedNativeBuildChecksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_native_stage_invalid/);
  assert.deepEqual(await readdir(root), ["input"]);
});

test("output aliases into the source tree are rejected before creating resources", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-overlap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  await mkdir(input);
  await symlink(input, join(root, "alias"), "junction");
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input,
    outputPath: join(root, "alias/nested/output"), expectedNativeBuildChecksum: `sha256:${"0".repeat(64)}`,
    target: { platform: "darwin", arch: "arm64" } }), /gstack_resource_input_output_overlap/);
  assert.deepEqual(await readdir(input), []);
});
