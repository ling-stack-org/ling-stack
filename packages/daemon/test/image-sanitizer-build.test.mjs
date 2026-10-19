import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyImageCodecDependencies } from "../scripts/image-codec-dependencies.mjs";

test("codec build reviews the reachable Cargo graph, including newly enabled optional dependencies", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-codec-license-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const license = "MIT License\nsynthetic test notice";
  await writeFile(join(root, "LICENSE-MIT"), license);
  const own = { id: "root", name: "ling-image-sanitizer", version: "0.1.0" };
  const dependency = { id: "codec", name: "codec", version: "1.0.0", source: "registry+https://github.com/rust-lang/crates.io-index",
    license: "MIT OR Apache-2.0", manifest_path: join(root, "Cargo.toml") };
  const optional = { ...dependency, id: "optional", name: "optional", license: "Zlib" };
  const metadata = { packages: [own, dependency, optional], resolve: { root: own.id, nodes: [
    { id: own.id, deps: [{ pkg: dependency.id, dep_kinds: [{ kind: null }] }] },
    { id: dependency.id, deps: [] }, { id: optional.id, deps: [] },
  ] } };
  const review = { name: "codec", version: "1.0.0", selectedLicense: "MIT", upstreamLicense: dependency.license,
    originalCrateSHA256: "a".repeat(64), licensePath: "LICENSE-MIT",
    licenseSHA256: createHash("sha256").update(license).digest("hex") };
  const input = { metadata, activePackages: [own, dependency], inventory: { active: [review] }, lock: { package: [
    { name: dependency.name, version: dependency.version, checksum: review.originalCrateSHA256 },
  ] }, notices: license, nativeRoot: root };
  assert.equal((await verifyImageCodecDependencies(input)).length, 1, "an unreachable optional lock entry is not compiled");
  const ambiguous = structuredClone(input);
  ambiguous.metadata.packages.unshift({ ...dependency, id: "unreviewed-source", source: "git+https://invalid.example/codec",
    license: "GPL-3.0", manifest_path: join(root, "unreviewed", "Cargo.toml") });
  ambiguous.activePackages.push(ambiguous.metadata.packages[0]);
  await assert.rejects(verifyImageCodecDependencies(ambiguous), /image_codec_dependency_ambiguous/,
    "same name and version from different Cargo sources cannot collapse into the reviewed package");
  const enabled = structuredClone(input);
  enabled.activePackages.push(optional);
  await assert.rejects(verifyImageCodecDependencies(enabled), /image_codec_dependency_unreviewed/);
  for (const change of [
    value => { value.inventory.active[0].selectedLicense = "GPL-3.0"; },
    value => { value.lock.package[0].checksum = "b".repeat(64); },
    value => { value.notices = "missing required text"; },
    value => { value.metadata.packages[1].license = "Unknown"; },
  ]) {
    const altered = structuredClone(input); change(altered);
    await assert.rejects(verifyImageCodecDependencies(altered), /image_codec_dependency_/);
  }
  await writeFile(join(root, "LICENSE-MIT"), "changed license bytes");
  await assert.rejects(verifyImageCodecDependencies(input), /image_codec_dependency_/);
});
