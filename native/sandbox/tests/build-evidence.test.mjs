import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildNativeEvidence, dependencyInventory, parseBuildArguments } from "../scripts/build.mjs";

const registry = "registry+https://github.com/rust-lang/crates.io-index";
const metadata = () => ({ workspace_members: ["ling"], packages: [
  { id: "ling", name: "ling-sandbox-runner", version: "0.1.0-dev.0", source: null, license: "MIT" },
  { id: "serde", name: "serde", version: "1.0.229", source: registry, license: "MIT OR Apache-2.0" },
  { id: "unicode", name: "unicode-ident", version: "1.0.24", source: registry, license: "(MIT OR Apache-2.0) AND Unicode-3.0" },
] });

test("build arguments accept only an explicit supported target and absolute output", () => {
  const output = join(tmpdir(), "ling-native-fixture-not-created");
  assert.deepEqual(parseBuildArguments(["--target", "aarch64-apple-darwin", "--out", output]), { target: "aarch64-apple-darwin", output });
  assert.equal(parseBuildArguments(["--out", output, "--target", "x86_64-pc-windows-msvc"]).target, "x86_64-pc-windows-msvc");
});

for (const [name, args] of [
  ["missing output", ["--target", "aarch64-apple-darwin"]],
  ["relative output", ["--target", "aarch64-apple-darwin", "--out", "relative"]],
  ["unknown target", ["--target", "x86_64-unknown-linux-gnu", "--out", "/tmp/test"]],
  ["extra flag", ["--target", "aarch64-apple-darwin", "--out", "/tmp/test", "--install", "true"]],
  ["repeated target", ["--target", "aarch64-apple-darwin", "--target", "x86_64-pc-windows-msvc", "--out", "/tmp/test"]],
  ["missing value", ["--out"]],
  ["null output", ["--target", "aarch64-apple-darwin", "--out", "/tmp/\0test"]],
]) test(name + " is rejected before build", () => assert.throws(() => parseBuildArguments(args), /invalid_build_arguments/));

test("inventory retains Unicode obligation and omits local machine paths", () => {
  const fixture = metadata();
  fixture.packages[1].manifest_path = "/private/build-machine/cache/serde/Cargo.toml";
  const result = dependencyInventory(fixture);
  assert.equal(result.length, 2);
  assert.equal(result[1].license, "(MIT OR Apache-2.0) AND Unicode-3.0");
  assert.ok(!JSON.stringify(result).includes("build-machine"));
  fixture.packages[1].name = "changed-after-projection";
  assert.equal(result[0].name, "serde");
});

for (const [name, change, code] of [
  ["another workspace crate", value => { value.packages.push({ id: "codex", name: "codex-protocol", source: null }); }, "unexpected_dependency_closure"],
  ["wrong native root", value => { value.packages[0].name = "not-ling"; }, "unexpected_dependency_closure"],
  ["multiple members", value => { value.workspace_members.push("other"); }, "unexpected_dependency_closure"],
  ["unreviewed license", value => { value.packages[1].license = "GPL-3.0-only"; }, "unreviewed_dependency"],
  ["missing license", value => { delete value.packages[1].license; }, "unreviewed_dependency"],
  ["unreviewed source", value => { value.packages[1].source = "git+https://example.invalid/other"; }, "unreviewed_dependency"],
  ["path in name", value => { value.packages[1].name = "../outside"; }, "unreviewed_dependency"],
  ["path in version", value => { value.packages[1].version = "1.0.0/../../outside"; }, "unreviewed_dependency"],
  ["duplicate dependency", value => { value.packages.push({ ...value.packages[1] }); }, "duplicate_dependency"],
]) test(name + " blocks build evidence", () => {
  const value = metadata();
  change(value);
  assert.throws(() => dependencyInventory(value), new RegExp(code));
});

test("existing output and its sentinel are never replaced or removed", () => {
  const output = mkdtempSync(join(tmpdir(), "ling-native-existing-output-"));
  const sentinel = join(output, "sentinel.txt");
  writeFileSync(sentinel, "keep-user-data", { flag: "wx" });
  assert.throws(() => buildNativeEvidence({ target: "aarch64-apple-darwin", output }), { code: "EEXIST" });
  assert.equal(readFileSync(sentinel, "utf8"), "keep-user-data");
});
