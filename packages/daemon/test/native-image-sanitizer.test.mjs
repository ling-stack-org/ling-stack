import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sanitizeNativeImage } from "../dist/runtime/adapters/native-image-sanitizer.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const signal = () => new AbortController().signal;
async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), "ling-image-transport-"));
  const path = join(root, process.platform === "win32" ? "ling-image-sanitizer.exe" : "ling-image-sanitizer");
  const previous = process.env.LING_IMAGE_SANITIZER_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.LING_IMAGE_SANITIZER_PATH;
    else process.env.LING_IMAGE_SANITIZER_PATH = previous;
    await rm(root, { recursive: true, force: true });
  });
  if (body) {
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o700);
  }
  process.env.LING_IMAGE_SANITIZER_PATH = path;
  return { root, path };
}

test("image codec missing, relative and substituted executables fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(sanitizeNativeImage(png, 1, signal()), { code: "invalid_artifact" });
  process.env.LING_IMAGE_SANITIZER_PATH = "ling-image-sanitizer";
  await assert.rejects(sanitizeNativeImage(png, 1, signal()), { code: "invalid_artifact" });
  if (process.platform !== "win32") {
    await symlink(process.execPath, f.path);
    process.env.LING_IMAGE_SANITIZER_PATH = f.path;
    await assert.rejects(sanitizeNativeImage(png, 1, signal()), { code: "invalid_artifact" });
  }
});

test("image codec output is accepted only after successful close and without inherited credentials", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, `const { writeFileSync } = require('node:fs');
    if (process.env.LING_TEST_CODEC_SECRET) process.exit(2);
    process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write(Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64'));
      setTimeout(() => { writeFileSync(require('node:path').join(__dirname, 'closed'), 'yes'); }, 50);
    });`);
  process.env.LING_TEST_CODEC_SECRET = "synthetic-test-value";
  t.after(() => { delete process.env.LING_TEST_CODEC_SECRET; });
  assert.deepEqual(await sanitizeNativeImage(png, 1, signal()), png);
  assert.equal(await readFile(join(f.root, "closed"), "utf8"), "yes");
});

test("image codec failures never return partial output", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  for (const [body, code] of [
    [`process.stdout.write(Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64')); process.exitCode = 2;`, "invalid_artifact"],
    ["process.exitCode = 3;", "unsupported_artifact"],
    ["process.exitCode = 4;", "capacity_exceeded"],
    ["process.stdout.write('not an image');", "invalid_artifact"],
    ["process.stderr.write('x'.repeat(5000)); setInterval(() => {}, 1000);", "invalid_artifact"],
    ["process.stdout.write(Buffer.alloc(25 * 1024 * 1024 + 1)); setInterval(() => {}, 1000);", "capacity_exceeded"],
  ]) {
    await writeFile(f.path, `#!${process.execPath}\nprocess.stdin.resume(); ${body}\n`);
    await chmod(f.path, 0o700);
    await assert.rejects(sanitizeNativeImage(png, 1, signal()), { code });
  }
});

test("image codec deadline and cancellation settle without publishing output", { timeout: 10000, skip: process.platform === "win32" }, async t => {
  await fixture(t, "process.stdin.resume(); setInterval(() => {}, 1000);");
  const abort = new AbortController();
  const reason = new Error("test cancellation");
  const pending = sanitizeNativeImage(png, 1, abort.signal);
  setTimeout(() => abort.abort(reason), 30);
  await assert.rejects(pending, error => error === reason);
  await assert.rejects(sanitizeNativeImage(png, 1, signal()), { code: "invalid_artifact" });
});
