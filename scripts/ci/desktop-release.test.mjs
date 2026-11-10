import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleRelease, collectTarget, desktopTargets, fileRecord, releaseVersion, readCandidate, validateCandidate } from "../release/desktop-release.mjs";
import { createDesktopDraft, verifyAssembledRelease } from "../release/create-desktop-draft.mjs";

const input = { sha: "a".repeat(40), tag: "v0.1.3", versionFile: "0.1.3",
  rootVersion: "0.1.3", desktopVersion: "0.1.3" };
const candidate = validateCandidate(input);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-desktop-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function draftFixture(t, mode = "success") {
  const f = await prepareBoth(t);
  await assembleRelease(f.args);
  const assets = await verifyAssembledRelease({ candidate, outputRoot: f.args.outputRoot });
  const calls = [];
  let tagLookups = 0;
  const repository = "example/ling-stack";
  const gh = async args => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("matching-refs")) {
        tagLookups++;
        if (mode === "api-error") throw new Error("GitHub authentication failed");
        return JSON.stringify(mode === "existing-tag" || mode === "tag-race" && tagLookups > 1
          ? [{ ref: `refs/tags/${candidate.tag}` }] : []);
      }
      if (args[1].includes("commits/")) return JSON.stringify({ sha: "b".repeat(40) });
      if (args[1].includes("releases?")) return JSON.stringify([[...(mode === "existing-release" ? [{ tag_name: candidate.tag }] : [])]]);
      const file = assets[Number(args[1].split("/").at(-1)) - 1];
      return JSON.stringify({ state: "uploaded", size: file.sizeBytes, digest: `sha256:${mode === "wrong-digest" ? "0".repeat(64) : file.sha256}` });
    }
    if (args[1] === "view") return JSON.stringify({ isDraft: true, isPrerelease: mode === "unexpected-prerelease", targetCommitish: candidate.sourceSha,
      url: "https://github.com/example/ling-stack/releases/test-draft", assets: assets.map((file, index) => ({ name: file.name,
        apiUrl: `https://api.github.com/repos/${repository}/releases/assets/${index + 1}` })) });
    return "";
  };
  return { ...f, calls, draft: { candidate, outputRoot: f.args.outputRoot, repository, gh } };
}

test("Draft creation uploads both platforms, verifies remote bytes and never publishes or replaces assets", async t => {
  const f = await draftFixture(t);
  const result = await createDesktopDraft(f.draft);
  assert.equal(result.published, false);
  assert.equal(result.assetCount, 14);
  const create = f.calls.find(args => args[1] === "create");
  assert.ok(create.includes("--draft") && !create.includes("--prerelease") && create.includes(candidate.sourceSha));
  assert.ok(f.calls.every(args => !args.includes("--clobber") && !args.includes("delete") && !args.includes("edit")));
});

for (const mode of ["existing-tag", "existing-release", "api-error", "wrong-digest", "tag-race", "unexpected-prerelease"]) {
  test(`Draft creation fails safely on ${mode}`, async t => {
    const f = await draftFixture(t, mode);
    await assert.rejects(createDesktopDraft(f.draft));
    const created = f.calls.some(args => args[1] === "create");
    assert.equal(created, mode === "wrong-digest" || mode === "tag-race" || mode === "unexpected-prerelease");
    assert.ok(f.calls.every(args => !args.includes("--clobber") && !args.includes("delete")));
  });
}

test("assembled checksum corruption is rejected before any GitHub call", async t => {
  const f = await draftFixture(t);
  await writeFile(join(f.args.outputRoot, "checksums.txt"), "tampered index");
  await assert.rejects(createDesktopDraft(f.draft), /checksum index changed/u);
  assert.equal(f.calls.length, 0);
});

test("release accepts numeric and historical prerelease tags, rejecting malformed or shell-shaped tags", () => {
  assert.equal(releaseVersion("v0.1.3"), "0.1.3");
  assert.equal(releaseVersion("v0.1.2-alpha.1"), "0.1.2-alpha.1");
  for (const tag of ["0.1.3", "v01.1.3", "v0.1.2-alpha.02", "v0.1.3+build", "v0.1.3\nother", "$(touch invalid)", "../../release"]) {
    assert.throws(() => releaseVersion(tag), /release tag/u);
  }
  for (const sha of ["main", "a".repeat(7), "A".repeat(40), "a".repeat(40) + "\n"]) {
    assert.throws(() => validateCandidate({ ...input, sha }), /complete lowercase/u);
  }
  for (const key of ["versionFile", "rootVersion", "desktopVersion"]) {
    assert.throws(() => validateCandidate({ ...input, [key]: "0.1.2-alpha.1" }), /versions must match/u);
  }
});

test("draft preparation requires a clean exact mainline source and a new tag", async t => {
  const root = await fixture(t);
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "release test"]);
  git(["config", "user.email", "release-test@example.invalid"]);
  await mkdir(join(root, "apps/desktop"), { recursive: true });
  await writeFile(join(root, "VERSION"), input.versionFile + "\n");
  for (const path of ["package.json", "apps/desktop/package.json"]) await writeFile(join(root, path), JSON.stringify({ version: input.rootVersion }));
  git(["add", "."]); git(["commit", "-qm", "candidate"]);
  const sha = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", sha]);
  const args = { root, sha, tag: input.tag, requireMain: true };
  assert.equal((await readCandidate(args)).sourceSha, sha);
  await assert.rejects(readCandidate({ ...args, sha: "b".repeat(40) }), /Checkout does not match/u);
  git(["tag", input.tag]);
  await assert.rejects(readCandidate(args), /Tag already exists/u);
  git(["tag", "-d", input.tag]);
  await writeFile(join(root, "VERSION"), input.versionFile + "\n\n");
  await assert.rejects(readCandidate(args), /source must be clean/u);
});

async function prepareBoth(t) {
  const root = await fixture(t), releases = join(root, "releases"), combined = join(root, "combined");
  await mkdir(releases); await mkdir(combined);
  for (const [target, suffixes] of Object.entries(desktopTargets)) {
    for (const suffix of suffixes) await writeFile(join(releases, `Ling-Stack-${candidate.version}-${suffix}`), `synthetic archive for ${suffix}`);
    const outputRoot = join(root, target);
    const evidenceRoot = join(root, `evidence-${target}`);
    await mkdir(evidenceRoot);
    await writeFile(join(evidenceRoot, "distribution.tar.gz"), "synthetic test distribution archive");
    await writeFile(join(evidenceRoot, "package-verification.json"), JSON.stringify({ ...candidate, target,
      status: "passed", acceptance: "archive_contents_and_unsigned_structure_only",
      distributionArchive: await fileRecord(join(evidenceRoot, "distribution.tar.gz")),
      archives: await Promise.all(suffixes.map(suffix => fileRecord(join(releases, `Ling-Stack-${candidate.version}-${suffix}`)))) }));
    await writeFile(join(evidenceRoot, "prerequisites.json"), JSON.stringify({ ...candidate, target, buildPrerequisitesPass: true }));
    const manifest = await collectTarget({ candidate, target, releaseRoot: releases, evidenceRoot, outputRoot });
    for (const file of [`desktop-${target}.json`, ...manifest.artifacts.map(file => file.name), ...manifest.evidence.map(file => file.name)]) {
      await writeFile(join(combined, file), await readFile(join(outputRoot, file)));
    }
  }
  return { root, combined, args: { candidate, inputRoot: combined, outputRoot: join(root, "final") } };
}

test("one release binds both targets to one version/SHA and hashes the actual downloads", async t => {
  const f = await prepareBoth(t);
  const result = await assembleRelease(f.args);
  assert.equal(result.targets.length, 2);
  assert.equal(result.releaseReady, false);
  const checksums = await readFile(join(f.args.outputRoot, "checksums.txt"), "utf8");
  assert.equal(checksums.trim().split("\n").length, 11);
  assert.match(await readFile(join(f.args.outputRoot, "release-notes.md"), "utf8"), /without Developer ID or notarization/u);
  await assert.rejects(assembleRelease(f.args), /EEXIST/u);
});

test("collection rejects archives replaced after package verification", async t => {
  const f = await prepareBoth(t), target = "windows-x64";
  await writeFile(join(f.root, "releases", `Ling-Stack-${candidate.version}-windows-x64-setup.exe`), "replacement before collection");
  await assert.rejects(collectTarget({ candidate, target, releaseRoot: join(f.root, "releases"),
    evidenceRoot: join(f.root, `evidence-${target}`), outputRoot: join(f.root, "recollect") }), /verification archives/u);
});

test("assembly rejects archive replacement even when the asset manifest was rehashed", async t => {
  const f = await prepareBoth(t), path = join(f.combined, "desktop-windows-x64.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const asset = join(f.combined, manifest.artifacts[0].name);
  await writeFile(asset, "replacement with matching new manifest hash");
  manifest.artifacts[0] = await fileRecord(asset);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(assembleRelease(f.args), /verification archives/u);
});

test("collection rejects distribution materials replaced after package verification", async t => {
  const f = await prepareBoth(t), target = "windows-x64";
  await writeFile(join(f.root, `evidence-${target}`, "distribution.tar.gz"), "unrelated material bytes");
  await assert.rejects(collectTarget({ candidate, target, releaseRoot: join(f.root, "releases"),
    evidenceRoot: join(f.root, `evidence-${target}`), outputRoot: join(f.root, "recollect-materials") }), /Distribution archive/u);
});

test("assembly rejects changed materials even when the asset manifest was rehashed", async t => {
  const f = await prepareBoth(t), path = join(f.combined, "desktop-windows-x64.json");
  const manifest = JSON.parse(await readFile(path, "utf8")), material = join(f.combined, manifest.evidence[2].name);
  await writeFile(material, "unrelated material bytes with a matching collection hash");
  manifest.evidence[2] = await fileRecord(material);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(assembleRelease(f.args), /Distribution archive/u);
});

for (const mutation of ["different-source", "different-version", "changed-archive", "changed-evidence", "missing-evidence", "missing-target", "extra-file", "path-traversal"]) {
  test(`release assembly rejects ${mutation} instead of mixing or replacing artifacts`, async t => {
    const f = await prepareBoth(t);
    const path = join(f.combined, "desktop-windows-x64.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (mutation === "different-source") manifest.sourceSha = "b".repeat(40);
    if (mutation === "different-version") manifest.version = "0.1.4";
    if (mutation === "path-traversal") manifest.artifacts[0].name = "../outside.exe";
    if (mutation === "missing-evidence") manifest.evidence = [];
    await writeFile(path, JSON.stringify(manifest));
    if (mutation === "changed-archive") await writeFile(join(f.combined, manifest.artifacts[0].name), "different bytes");
    if (mutation === "changed-evidence") await writeFile(join(f.combined, manifest.evidence[0].name), "different evidence");
    if (mutation === "missing-target") await rm(path);
    if (mutation === "extra-file") await writeFile(join(f.combined, "old-setup.exe"), "stale");
    await assert.rejects(assembleRelease(f.args));
  });
}
