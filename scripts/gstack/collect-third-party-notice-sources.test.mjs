import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectGstackThirdPartyNoticeSources } from "./collect-third-party-notice-sources.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const revision = "a".repeat(40);
const notice = await readFile(new URL("../../LICENSE", import.meta.url));
function githubFile(bytes = notice) {
  return { type: "file", encoding: "base64", content: bytes.toString("base64"),
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
}
const metadata = { name: "helper", version: "1.0.0", gitHead: revision,
  repository: { url: "git+https://github.com/fixture/helper.git" } };
const registry = { url: "https://registry.npmjs.org/helper/1.0.0", checksum: checksum("fixture registry"),
  gitHead: revision, repository: metadata.repository, integrity: "sha512-fixture" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-notice-collector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auditPath = join(root, "audit.json");
  const audit = { schemaVersion: 1, packages: [
    { name: "helper", version: "1.0.0", license: "MIT", path: "node_modules/helper" },
    { name: "helper", version: "1.0.0", license: "MIT", path: "lib/diagram-render/node_modules/helper" },
    { name: "unrelated", version: "1.0.0", license: "MIT", path: "node_modules/unrelated" },
  ], blockers: [
    { code: "dependency_notice_missing", path: "node_modules/helper" },
    { code: "dependency_notice_missing", path: "lib/diagram-render/node_modules/helper" },
  ] };
  await writeFile(auditPath, JSON.stringify(audit));
  return { root, audit, auditPath, outputPath: join(root, "candidate.json") };
}

test("collector deduplicates exact missing package versions and retains independently checked source hashes", async t => {
  const f = await fixture(t);
  let registryCalls = 0;
  const githubCalls = [];
  const result = await collectGstackThirdPartyNoticeSources({ ...f,
    registryReader: async (name, version) => { registryCalls++; assert.equal(name, "helper"); assert.equal(version, "1.0.0"); return { metadata, registry }; },
    githubReader: async path => { githubCalls.push(path); return githubFile(); },
  });
  assert.equal(registryCalls, 1);
  assert.deepEqual(githubCalls, [`repos/fixture/helper/contents/LICENSE?ref=${revision}`]);
  assert.equal(result.installedMissingNoticeCount, 2);
  assert.equal(result.uniquePackageCount, 1);
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.entries[0].source.checksum, checksum(notice));
  assert.equal(result.inputAuditChecksum, checksum(await readFile(f.auditPath)));
  assert.equal(result.releaseEligible, false);
  assert.equal(result.reviewStatus, "candidate-only");
  assert.deepEqual(JSON.parse(await readFile(f.outputPath, "utf8")), result);
});

test("registry identity mismatch and missing full gitHead never fall back to current main", async t => {
  for (const changed of [{ ...metadata, name: "wrong" }, { ...metadata, version: "2.0.0" },
    { ...metadata, gitHead: undefined }, { ...metadata, gitHead: "abcdef0" },
    { ...metadata, repository: { url: "https://example.com/fixture/helper" } }]) {
    const f = await fixture(t);
    let calls = 0;
    const result = await collectGstackThirdPartyNoticeSources({ ...f,
      registryReader: async () => ({ metadata: changed, registry }),
      githubReader: async () => { calls++; return githubFile(); },
    });
    assert.equal(calls, 0);
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /mismatch|missing|unresolved/);
    assert.equal(result.releaseEligible, false);
  }
});

test("candidate collection rejects corrupt Git blobs, invalid UTF-8, oversized text and non-files", async t => {
  for (const data of [{ ...githubFile(), sha: "b".repeat(40) }, githubFile(Buffer.from([0xff])),
    githubFile(Buffer.from([0])), githubFile(Buffer.alloc(256 * 1024 + 1, 65)),
    { ...githubFile(), type: "symlink" }, { ...githubFile(), encoding: "none" }]) {
    const f = await fixture(t);
    const result = await collectGstackThirdPartyNoticeSources({ ...f,
      registryReader: async () => ({ metadata, registry }), githubReader: async () => data,
    });
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /notice_source_/);
    assert.equal(result.entries[0].source, undefined);
  }
});

test("404 alternatives stay at the recorded revision and permission failures remain unresolved", async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await collectGstackThirdPartyNoticeSources({ ...f,
    registryReader: async () => ({ metadata, registry }),
    githubReader: async path => {
      calls.push(path);
      if (path.includes("/LICENSE?")) { const error = new Error("not found"); error.stderr = "HTTP 404"; throw error; }
      return githubFile();
    },
  });
  assert.equal(result.entries[0].source.path, "LICENSE.md");
  assert.equal(calls.every(path => path.endsWith(`?ref=${revision}`)), true);
  const other = await fixture(t);
  const denied = await collectGstackThirdPartyNoticeSources({ ...other,
    registryReader: async () => ({ metadata, registry }),
    githubReader: async () => { const error = new Error("permission denied"); error.stderr = "HTTP 403"; throw error; },
  });
  assert.equal(denied.entries[0].status, "unresolved");
  assert.equal(denied.entries[0].reason, "permission denied");
});

test("a mismatched repository license remains a candidate, never a redistribution approval", async t => {
  const f = await fixture(t);
  f.audit.packages.forEach(pkg => { pkg.license = "LGPL-3.0-or-later"; });
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  const text = Buffer.from("Apache License\nVersion 2.0\nTooling only, not the bundled library license.\n");
  const result = await collectGstackThirdPartyNoticeSources({ ...f,
    registryReader: async () => ({ metadata, registry }), githubReader: async () => githubFile(text),
  });
  assert.equal(result.entries[0].license, "LGPL-3.0-or-later");
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.reviewStatus, "candidate-only");
  assert.equal(result.releaseEligible, false);
});

test("existing output is not overwritten and invalid audits make no network requests", async t => {
  const f = await fixture(t);
  await writeFile(f.outputPath, "keep investigative data");
  const registryReader = () => { throw new Error("unexpected network access"); };
  await assert.rejects(collectGstackThirdPartyNoticeSources({ ...f, registryReader }), /notice_source_output_exists/);
  assert.equal(await readFile(f.outputPath, "utf8"), "keep investigative data");
  await writeFile(f.auditPath, JSON.stringify({ schemaVersion: 2, packages: [], blockers: [] }));
  await assert.rejects(collectGstackThirdPartyNoticeSources({ ...f, registryReader }), /notice_source_audit_invalid/);
});

test("only declared exact release tags can recover a missing gitHead after source package verification", async t => {
  const f = await fixture(t);
  const calls = [];
  const packageBytes = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT" }));
  const result = await collectGstackThirdPartyNoticeSources({ ...f,
    releaseTagSources: [{ name: "helper", version: "1.0.0", license: "MIT", repository: "fixture/helper", tag: "v1.0.0", revision,
      packagePath: "src/package.json" }],
    registryReader: async () => ({ metadata: { ...metadata, gitHead: undefined }, registry: { ...registry, gitHead: null } }),
    githubReader: async path => {
      calls.push(path);
      if (path.includes("/git/ref/")) return { ref: "refs/tags/v1.0.0", object: { type: "commit", sha: revision } };
      if (path.includes("src/package.json")) return githubFile(packageBytes);
      return githubFile();
    },
  });
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.entries[0].registry.gitHead, null);
  assert.equal(result.entries[0].source.revisionProof.kind, "exact-version-tag");
  assert.equal(result.entries[0].source.revision, revision);
  assert.deepEqual(calls, ["repos/fixture/helper/git/ref/tags/v1.0.0",
    `repos/fixture/helper/contents/src/package.json?ref=${revision}`, `repos/fixture/helper/contents/LICENSE?ref=${revision}`]);
  assert.equal(result.releaseEligible, false);
});

test("a changed release tag or mismatched source version leaves the package unresolved", async t => {
  for (const mismatch of ["tag", "version"]) {
    const f = await fixture(t);
    const result = await collectGstackThirdPartyNoticeSources({ ...f,
      releaseTagSources: [{ name: "helper", version: "1.0.0", license: "MIT", repository: "fixture/helper", tag: "v1.0.0", revision,
        packagePath: "src/package.json" }],
      registryReader: async () => ({ metadata: { ...metadata, gitHead: undefined }, registry: { ...registry, gitHead: null } }),
      githubReader: async path => {
        if (path.includes("/git/ref/")) return { ref: "refs/tags/v1.0.0", object: { type: "commit", sha: mismatch === "tag" ? "b".repeat(40) : revision } };
        return githubFile(Buffer.from(JSON.stringify({ name: "helper", version: mismatch === "version" ? "2.0.0" : "1.0.0", license: "MIT" })));
      },
    });
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /notice_source_release_/);
  }
});

test("a declared bare version tag is verified at its exact commit without querying mutable main", async t => {
  const f = await fixture(t);
  const packageBytes = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT" }));
  const requests = [];
  const result = await collectGstackThirdPartyNoticeSources({ ...f,
    releaseTagSources: [{ name: "helper", version: "1.0.0", license: "MIT", repository: "fixture/helper", tag: "1.0.0", revision,
      packagePath: "package.json" }],
    registryReader: async () => ({ metadata: { ...metadata, gitHead: undefined }, registry: { ...registry, gitHead: null } }),
    githubReader: async path => {
      requests.push(path);
      if (path.includes("/git/ref/")) return { ref: "refs/tags/1.0.0", object: { type: "commit", sha: revision } };
      return githubFile(path.includes("/package.json?") ? packageBytes : notice);
    },
  });
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.entries[0].source.revisionProof.tag, "1.0.0");
  assert.deepEqual(requests, ["repos/fixture/helper/git/ref/tags/1.0.0",
    `repos/fixture/helper/contents/package.json?ref=${revision}`, `repos/fixture/helper/contents/LICENSE?ref=${revision}`]);
  assert.equal(result.releaseEligible, false);
});

test("README files can be collected at the exact revision but a license heading alone is still only a candidate", async t => {
  const f = await fixture(t);
  const result = await collectGstackThirdPartyNoticeSources({ ...f, registryReader: async () => ({ metadata, registry }),
    githubReader: async path => {
      if (path.includes("/README.md?")) return githubFile(Buffer.from("# README\n## MIT Licenced\n"));
      const error = new Error("missing file"); error.stderr = "HTTP 404"; throw error;
    },
  });
  assert.equal(result.entries[0].source.path, "README.md");
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.reviewStatus, "candidate-only");
});
