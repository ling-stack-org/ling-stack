import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadReviewedCompiler, verifyReviewedCompiler } from "./rebuild-reviewed-resource-stage.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-reviewed-tool-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "bun.zip");
}

test("compiler transport rejects foreign redirects and encoded or oversized responses before publication", async t => {
  const path = await fixture(t);
  let requests = 0;
  await assert.rejects(downloadReviewedCompiler(path, async () => {
    requests++; return new Response(null, { status: 302, headers: { location: "https://example.com/bun.zip" } });
  }), /endpoint_invalid/);
  assert.equal(requests, 1);
  for (const headers of [{ "content-length": `${64 * 1024 ** 2 + 1}` }, { "content-encoding": "gzip" }]) {
    await assert.rejects(downloadReviewedCompiler(path, async () => new Response("transport", { headers })), /size_invalid/);
  }
});

test("transport uses a fixed public version and refuses overwrite; transport success is not binary admission", async t => {
  const path = await fixture(t);
  assert.equal(await downloadReviewedCompiler(path, async (url, options) => {
    assert.equal(url, "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip");
    assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
    return new Response("untrusted bytes", { headers: { "content-length": "15" } });
  }), 15);
  await assert.rejects(verifyReviewedCompiler(path), /checksum_mismatch/);
  await assert.rejects(downloadReviewedCompiler(path, async () => new Response("other")), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "untrusted bytes");
});

test("truncated compiler archive cannot become a valid download", async t => {
  const path = await fixture(t);
  await assert.rejects(downloadReviewedCompiler(path, async () => new Response("short", { headers: { "content-length": "10" } })), /size_invalid/);
  await writeFile(path, "fake compiler");
  await assert.rejects(verifyReviewedCompiler(path), /checksum_mismatch/);
});
