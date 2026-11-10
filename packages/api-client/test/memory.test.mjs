import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError } from "../dist/index.js";

function fixture() {
  const calls = [];
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return Response.json({ status: "ready", human: { revision: 4, text: "Keep this note" } });
  } });
  return { client, calls };
}

// Value: protects=Wiki reads, compile, export and notes retain exact scope and note CAS;
// fails_when=an endpoint drops or moves scope, uses a wrong verb, or omits the expected revision;
// why_new=the server API test bypasses the public client request builder; seam=none;
// no_claim=daemon authorization, filesystem publication or browser behavior (fetch mocked).
test("Wiki client preserves exact owner, cwd and note revision on every derivative request", async () => {
  const { client, calls } = fixture();
  const cwd = "/workspace 中文/with spaces";
  const scope = { scopeType: "teammate", ownerId: "owner / 私有?&" };
  await client.getMemoryWiki(cwd, scope);
  await client.compileMemoryWiki(cwd, scope);
  await client.exportMemoryWiki(cwd, scope);
  const notes = { expectedRevision: 3, text: "Keep this note" };
  await client.updateMemoryWikiHumanBlock(cwd, scope, notes);
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ["GET", "/memory/wiki"], ["POST", "/memory/wiki/compile"],
    ["GET", "/memory/wiki/export"], ["PUT", "/memory/wiki/human"],
  ]);
  for (const call of calls) assert.deepEqual(Object.fromEntries(call.url.searchParams), { cwd, ...scope });
  assert.deepEqual(calls.map(call => call.body), [undefined, undefined, undefined, notes]);
});

// Value: protects=semantic configuration CAS, explicit remote policy and memory IDs survive client transport;
// fails_when=flags or revisions are discarded, IDs become path segments, or a conflict is swallowed;
// why_new=existing generic transport tests do not exercise the new semantic and single-memory methods; seam=none;
// no_claim=embedding quality or server-side private-data enforcement (fetch mocked).
test("memory and semantic client requests preserve encoded identity, opt-ins and conflict errors", async () => {
  const { client, calls } = fixture();
  const cwd = "/repo", memoryId = "memory / 中文?";
  await client.getMemoryObject(cwd, memoryId);
  await client.getMemorySemanticPolicy(cwd);
  const policy = { mode: "lancedb", expectedRevision: 7, providerPresetId: "provider / 一", model: "local-embedding",
    dimensions: 768, maxDistance: 0.2, timeoutMs: 1000, allowRemote: false, allowPrivateRemote: false };
  await client.updateMemorySemanticPolicy(cwd, policy);
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname, call.url.searchParams.get("cwd")]), [
    ["GET", `/memory/${encodeURIComponent(memoryId)}`, cwd],
    ["GET", "/memory/semantic-policy", cwd], ["PUT", "/memory/semantic-policy", cwd],
  ]);
  assert.deepEqual(calls[2].body, policy);
  const rejected = new LingDaemonClient({ fetch: async () => Response.json({ error: "memory_semantic_policy_conflict" }, { status: 409 }) });
  await assert.rejects(rejected.updateMemorySemanticPolicy(cwd, policy),
    error => error instanceof LingDaemonError && error.status === 409 && error.code === "memory_semantic_policy_conflict");
});
