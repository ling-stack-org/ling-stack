import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyImageCodecDependencies } from "../scripts/image-codec-dependencies.mjs";

test("image sanitizer build explains a missing or outdated Rust toolchain before compiling", {
  skip: process.platform === "win32" ? "Executable PATH fixtures require POSIX shebang support" : false,
}, async t => {
  const tools = await mkdtemp(join(tmpdir(), "ling-codec-toolchain-"));
  t.after(() => rm(tools, { recursive: true, force: true }));
  const build = new URL("../scripts/build-image-sanitizer.mjs", import.meta.url);
  const run = () => spawnSync(process.execPath, [build.pathname], {
    env: { ...process.env, PATH: tools }, encoding: "utf8",
  });
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Rust .*Cargo.*required/);
  assert.match(missing.stderr, /rustup/);

  const rustc = join(tools, "rustc");
  const host = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
  const compiler = version => `#!${process.execPath}\nconsole.log("rustc ${version}\\nrelease: ${version}\\nhost: ${host}");\n`;
  await writeFile(rustc, compiler("1.85.1"));
  await chmod(rustc, 0o755);
  const outdated = run();
  assert.notEqual(outdated.status, 0);
  assert.match(outdated.stderr, /Rust 1\.89(?:\.0)?\+.*found 1\.85\.1/);
  assert.match(outdated.stderr, /rustup/);

  await writeFile(rustc, compiler("1.89.0"));
  const missingCargo = run();
  assert.notEqual(missingCargo.status, 0);
  assert.match(missingCargo.stderr, /Rust .*Cargo.*required/);
  assert.doesNotMatch(missingCargo.stderr, /Unsupported compiler/);

  const cargo = join(tools, "cargo");
  await writeFile(cargo, `#!${process.execPath}\nprocess.exit(process.argv[2] === "--version" ? 0 : 1);\n`);
  await chmod(cargo, 0o755);
  const accepted = run();
  assert.match(accepted.stderr, /image_sanitizer_dependency_graph_failed/,
    "the minimum accepted toolchain proceeds to dependency review");
});

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
