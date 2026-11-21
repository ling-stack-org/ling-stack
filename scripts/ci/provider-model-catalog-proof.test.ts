import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { findProviderModelCatalogProof } from "./provider-model-catalog-proof.mjs";

const source = Buffer.from("candidate catalog");
const digest = createHash("sha256").update(source).digest("hex");
const name = `provider-model-catalog-${digest}`;
const context = {
  repo: { owner: "ling-stack-org", repo: "ling-stack" },
  payload: { repository: { id: 1234, default_branch: "main" } },
};
const run = {
  path: ".github/workflows/sync-provider-model-catalog.yml",
  head_branch: "main",
  repository: { id: 1234 },
  head_repository: { id: 1234 },
  event: "schedule",
};
const artifact = { name, expired: false, workflow_run: { id: 500 } };

function proofLookup(options: { artifacts?: object[]; producer?: object; unavailable?: boolean } = {}) {
  const { artifacts = [artifact], producer = run, unavailable = false } = options;
  const requests: object[] = [];
  const github = { rest: { actions: {
    async listArtifactsForRepo({ request, ...parameters }: { request: { signal: AbortSignal }; name: string }) {
      assert.ok(request.signal instanceof AbortSignal);
      requests.push(parameters);
      if (unavailable) throw new Error("GitHub unavailable");
      return { data: { artifacts } };
    },
    async getWorkflowRun({ request, ...parameters }: { request: { signal: AbortSignal }; run_id: number }) {
      assert.ok(request.signal instanceof AbortSignal);
      requests.push(parameters);
      return { data: producer };
    },
  } } };
  return { requests, verify: (candidate = source) => findProviderModelCatalogProof({ github, context, source: candidate }) };
}

test("only the matching artifact from the repository's main generator proves a catalog", async () => {
  const lookup = proofLookup();
  assert.equal(await lookup.verify(), digest);
  assert.deepEqual(lookup.requests, [
    { ...context.repo, name, per_page: 10 },
    { ...context.repo, run_id: 500 },
  ]);
  assert.equal(await lookup.verify(Buffer.from("edited catalog")), undefined);
});

test("catalog proof rejects missing, expired and unrelated artifacts and falls back when lookup fails", async () => {
  for (const artifacts of [[], [{ ...artifact, expired: true }], [{ ...artifact, name: "unrelated" }], [{ name, expired: false }]]) {
    const lookup = proofLookup({ artifacts });
    assert.equal(await lookup.verify(), undefined);
    assert.equal(lookup.requests.length, 1);
  }
  assert.equal(await proofLookup({ unavailable: true }).verify(), undefined);
});

test("a matching digest from a different workflow, branch, fork or event is insufficient", async () => {
  for (const overrides of [{ path: ".github/workflows/ci.yml" }, { head_branch: "candidate" },
    { head_repository: { id: 5678 } }, { repository: { id: 5678 } }, { event: "pull_request" }]) {
    assert.equal(await proofLookup({ producer: { ...run, ...overrides } }).verify(), undefined);
  }
});
