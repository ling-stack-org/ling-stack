import assert from "node:assert/strict";
import test from "node:test";
import { readPublicGstackGithubMetadata } from "./public-github-metadata.mjs";

const endpoint = "repos/ungoogled-software/ungoogled-chromium-macos/git/ref/tags/154.0.8037.97-1.1";
test("fixed public upstream metadata uses no login, ambient credentials, redirects or executable CLI", async () => {
  assert.deepEqual(await readPublicGstackGithubMetadata(endpoint, async (url, options) => {
    assert.equal(url, `https://api.github.com/${endpoint}`);
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.authorization, undefined);
    return new Response('{"ref":"fixture"}');
  }), { ref: "fixture" });
  let requests = 0;
  for (const value of ["https://example.com/token", "repos/other/project/contents/file", endpoint + "/../../other", endpoint + "#fragment"]) {
    await assert.rejects(readPublicGstackGithubMetadata(value, async () => { requests++; }), /endpoint_invalid/);
  }
  assert.equal(requests, 0);
});
test("public metadata errors and both declared and streaming size excess fail closed", async () => {
  await assert.rejects(readPublicGstackGithubMetadata(endpoint, async () => new Response(null, { status: 403 })), /http_403/);
  await assert.rejects(readPublicGstackGithubMetadata(endpoint, async () => new Response("{}", { headers: { "content-length": `${4 * 1024 ** 2 + 1}` } })), /too_large/);
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(4 * 1024 ** 2 + 1)); controller.close(); } });
  await assert.rejects(readPublicGstackGithubMetadata(endpoint, async () => new Response(body)), /too_large/);
  await assert.rejects(readPublicGstackGithubMetadata(endpoint, async () => new Response("invalid JSON")), SyntaxError);
});
