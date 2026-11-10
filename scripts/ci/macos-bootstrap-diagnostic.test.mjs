import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { collectBootstrapDiagnostic, PROFILE_PATH } from "./macos-bootstrap-diagnostic.mjs";

function fixture(options = {}) {
  const content = Buffer.from("(version 1)\n; observed bytes, never authorization\n");
  const stat = { dev: 1n, ino: 2n, uid: 0n, mode: 0o100644n, size: BigInt(content.length),
    isFile: () => true, isSymbolicLink: () => false, ...options.stat };
  let position = 0, opens = 0, closes = 0, stats = 0;
  const io = {
    lstatSync(path) { assert.equal(path, PROFILE_PATH); return stat; },
    realpathSync(path) { assert.equal(path, PROFILE_PATH); return options.realpath ?? path; },
    openSync(path, flags) {
      assert.equal(path, PROFILE_PATH);
      assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); opens++; return 41;
    },
    fstatSync(fd) { assert.equal(fd, 41); return options.replace && ++stats > 1 ? { ...stat, ino: 3n } : stat; },
    readSync(fd, buffer, offset, length, readPosition) {
      assert.equal(fd, 41); assert.equal(readPosition, null);
      if (options.readError) throw new Error("private error detail must not escape");
      const count = Math.min(length, options.chunk ?? content.length, content.length - position);
      content.copy(buffer, offset, position, position + count); position += count; return count;
    },
    closeSync(fd) { assert.equal(fd, 41); closes++; if (options.closeError) throw new Error("close failed"); },
  };
  const exec = (path, args, flags) => {
    assert.equal(path, "/usr/bin/sw_vers"); assert.equal(flags.timeout, 5000); assert.equal(flags.maxBuffer, 8192);
    return args[0] === "-productVersion" ? "26.6.2\n" : "25G83\n";
  };
  return { io, exec, platform: "darwin", arch: "arm64", kernel: "25.6.0", content,
    counts: () => ({ opens, closes }) };
}

test("bounded partial reads preserve exact source bytes and identify their OS without certification", () => {
  const f = fixture({ chunk: 3 }), result = collectBootstrapDiagnostic(f);
  assert.equal(result.collected, true); assert.equal(result.observationOnly, true);
  assert.deepEqual(Buffer.from(result.bytesBase64, "base64"), f.content);
  assert.equal(result.sha256, createHash("sha256").update(f.content).digest("hex"));
  assert.equal(result.osVersion, "26.6.2"); assert.equal(result.osBuild, "25G83");
  assert.equal(Object.hasOwn(result, "reviewed"), false); assert.deepEqual(f.counts(), { opens: 1, closes: 1 });
});

for (const options of [{ stat: { uid: 501n } }, { stat: { mode: 0o100666n } },
  { stat: { isSymbolicLink: () => true } }, { stat: { size: 0n } },
  { stat: { size: 8n * 1024n * 1024n + 1n } }, { realpath: "/another/source" }]) {
  test(`unsafe source is reported before open: ${JSON.stringify(options, (_, v) => typeof v === "bigint" ? String(v) : v)}`, () => {
    const f = fixture(options), result = collectBootstrapDiagnostic(f);
    assert.equal(result.collected, false); assert.equal(result.diagnosticError, "bootstrap_diagnostic_identity_invalid");
    assert.deepEqual(f.counts(), { opens: 0, closes: 0 }); assert.equal(result.bytesBase64, undefined);
  });
}

for (const options of [{ replace: true }, { readError: true }, { closeError: true }, { stat: { size: 1n } }]) {
  test(`read/identity/close failure cannot return a successful observation: ${JSON.stringify(options, (_, v) => typeof v === "bigint" ? String(v) : v)}`, () => {
    const f = fixture(options), result = collectBootstrapDiagnostic(f);
    assert.equal(result.collected, false); assert.equal(result.bytesBase64, undefined);
    assert.equal(f.counts().closes, 1); assert.doesNotMatch(JSON.stringify(result), /private error detail/u);
  });
}

test("non-macOS diagnostic never touches the filesystem or runs a command", () => {
  const result = collectBootstrapDiagnostic({ platform: "linux", io: {}, exec() { assert.fail("no commands"); } });
  assert.equal(result.collected, false); assert.equal(result.diagnosticError, "bootstrap_diagnostic_requires_macos");
});

test("both actual macOS lanes preserve diagnostics while retaining mandatory test gates", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const id of ["daemon-tests", "restricted-command-macos"]) {
    const rest = workflow.slice(workflow.indexOf(`\n  ${id}:\n`) + 1);
    const job = rest.split(/\n  [a-z][a-z0-9-]*:\n/u)[0];
    assert.match(job, /node scripts\/ci\/macos-bootstrap-diagnostic\.mjs/u);
    assert.match(job, /if: always\(\)[\s\S]*macos-bootstrap-diagnostic\.json/u);
    assert.doesNotMatch(job, /continue-on-error/u);
  }
});
