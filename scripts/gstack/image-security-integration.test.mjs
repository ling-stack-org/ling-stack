import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { applyImageParserSecurityPatches } from "./patch-image-parsers.mjs";

const root = process.env.LING_GSTACK_NATIVE_CANDIDATE
  ? resolve(process.env.LING_GSTACK_NATIVE_CANDIDATE, "runtime") : undefined;
const options = { skip: !root && "Set LING_GSTACK_NATIVE_CANDIDATE to a native dependency candidate" };
const originalRoot = process.env.LING_GSTACK_UNPATCHED_CANDIDATE
  ? resolve(process.env.LING_GSTACK_UNPATCHED_CANDIDATE, "runtime") : undefined;

function proof(script) {
  execFileSync(process.execPath, ["--max-old-space-size=64", "-e", script], {
    encoding: "utf8", timeout: 3_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, HOME: tmpdir() }, stdio: ["ignore", "pipe", "pipe"],
  });
}

test("native image parser rejects zero-length and malformed ICNS entries without hanging", options, () => {
  const require = createRequire(join(root, "package.json"));
  const entry = join(dirname(require.resolve("image-size")), "types/icns.js");
  proof(`
    const assert = require("node:assert/strict");
    const { ICNS } = require(${JSON.stringify(entry)});
    for (const [length, entryLength] of [[16, 0], [16, 7], [16, 20], [12, 0]]) {
      const input = Buffer.alloc(length);
      input.write("icns"); input.writeUInt32BE(length, 4);
      if (length >= 16) { input.write("ic07", 8); input.writeUInt32BE(entryLength, 12); }
      assert.throws(() => ICNS.calculate(input), /Invalid ICNS/);
    }
    const valid = Buffer.alloc(24);
    valid.write("icns"); valid.writeUInt32BE(24, 4);
    valid.write("ic07", 8); valid.writeUInt32BE(8, 12);
    valid.write("ic08", 16); valid.writeUInt32BE(8, 20);
    assert.deepEqual(ICNS.calculate(valid).images.map(i => i.type), ["ic07", "ic08"]);
  `);
});

test("native HEIF and JXL parser target boxes must advance and stay within bounds", options, () => {
  const require = createRequire(join(root, "package.json"));
  const types = join(dirname(require.resolve("image-size")), "types");
  proof(`
    const assert = require("node:assert/strict");
    const { HEIF } = require(${JSON.stringify(join(types, "heif.js"))});
    const { JXL } = require(${JSON.stringify(join(types, "jxl.js"))});
    const { findBox } = require(${JSON.stringify(join(types, "utils.js"))});
    for (const length of [0, 4, 16]) {
      for (const [type, parser] of [["meta", HEIF], ["jxlp", JXL]]) {
        const input = Buffer.alloc(8); input.writeUInt32BE(length); input.write(type, 4);
        assert.equal(findBox(input, type, 0), undefined);
        assert.throws(() => parser.calculate(input));
      }
    }
    assert.equal(findBox(Buffer.alloc(7), "meta", 0), undefined);
  `);
});

for (const format of ["umd", "esm"]) {
  test(`actual ${format} DOCX converter rejects embedded malformed ICNS and preserves valid images`, options, async (t) => {
    const require = createRequire(join(root, "package.json"));
    const entry = require.resolve("html-to-docx");
    let load = `require(${JSON.stringify(entry)})`;
    if (format === "esm") {
      const scratch = await mkdtemp(join(tmpdir(), "ling-docx-esm-proof-"));
      t.after(() => rm(scratch, { recursive: true, force: true }));
      const copy = join(scratch, "converter.mjs");
      await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "junction");
      await copyFile(join(dirname(entry), "html-to-docx.esm.js"), copy);
      load = `(await import(${JSON.stringify(pathToFileURL(copy).href)})).default`;
    }
    proof(`
      const assert = require("node:assert/strict");
      (async () => {
        const convert = ${load};
        const bad = Buffer.alloc(16); bad.write("icns"); bad.writeUInt32BE(16, 4); bad.write("ic07", 8);
        await assert.rejects(convert('<p><img src="data:image/png;base64,' + bad.toString("base64") + '"></p>'), /Invalid ICNS/);
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6cAAAAASUVORK5CYII=";
        const result = await convert('<p>Preserved image</p><p><img src="data:image/png;base64,' + png + '"></p>');
        const zip = await require(${JSON.stringify(require.resolve("jszip"))}).loadAsync(result);
        assert.match(await zip.file("word/document.xml").async("string"), /Preserved image/);
        assert.ok(Object.keys(zip.files).some(p => /^word\\/media\\/.*\\.png$/.test(p)));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
  });
}

test("image backports reject changed installed input before mutating other dependencies", {
  skip: !originalRoot && "Set LING_GSTACK_UNPATCHED_CANDIDATE to the original pinned dependency candidate",
}, async (t) => {
  const work = await mkdtemp(join(tmpdir(), "ling-image-patch-tamper-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(join(work, "node_modules"));
  await writeFile(join(work, "package.json"), "{}");
  for (const name of ["image-size", "html-to-docx"]) {
    await cp(join(originalRoot, "node_modules", name), join(work, "node_modules", name), { recursive: true });
  }
  const first = join(work, "node_modules/image-size/dist/types/icns.js");
  const before = await readFile(first);
  const changed = join(work, "node_modules/html-to-docx/dist/html-to-docx.esm.js");
  await writeFile(changed, `${await readFile(changed, "utf8")}\n// unreviewed change\n`);
  await assert.rejects(applyImageParserSecurityPatches({ runtimeRoot: work }), /gstack_image_input_changed_review_patch/);
  assert.deepEqual(await readFile(first), before);
  await assert.rejects(readFile(join(work, "patches/ling-image-parser-backports.mjs")), { code: "ENOENT" });
});
