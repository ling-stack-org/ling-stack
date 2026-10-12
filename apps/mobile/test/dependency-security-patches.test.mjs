import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const localRequire = createRequire(import.meta.url);
const expoRequire = createRequire(localRequire.resolve("expo/package.json"));
const nativeRequire = createRequire(expoRequire.resolve("react-native/package.json"));
const nativeCliRequire = createRequire(nativeRequire.resolve("@react-native/community-cli-plugin/package.json"));
const metroRequire = createRequire(nativeCliRequire.resolve("metro/package.json"));
// SDK57's Metro uses its own image parser. Resolve the patched dependency from
// its real PPTX consumer instead of accepting Metro's hoisted fallback.
const daemonRequire = createRequire(new URL("../../../packages/daemon/package.json", import.meta.url));
const pptxRequire = createRequire(daemonRequire.resolve("pptxgenjs"));
const imageSizeRequire = createRequire(pptxRequire.resolve("image-size"));
const imageSizeManifest = imageSizeRequire("../../package.json");
const heifModulePath = imageSizeRequire.resolve("image-size/types/heif");
const icnsModulePath = imageSizeRequire.resolve("image-size/types/icns");
const jxlModulePath = imageSizeRequire.resolve("image-size/types/jxl");
const utilsModulePath = imageSizeRequire.resolve("image-size/types/utils");

assert.equal(imageSizeManifest.version, "2.0.4");

async function runBoundedProof(source, label) {
  const child = spawn(process.execPath, ["-e", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${label} exceeded the 1 second safety deadline`)));
    }, 1_000);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
        if (code === 0 && signal === null) {
          resolve();
          return;
        }
        reject(new Error(`${label} failed with code=${code} signal=${signal ?? ""}\n${stdout}${stderr}`));
      });
    });
  });
}

test("patched image-size rejects a zero-length ICNS entry", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { ICNS } = require(${JSON.stringify(icnsModulePath)});
      const input = Buffer.alloc(16);
      input.write("icns", 0);
      input.writeUInt32BE(16, 4);
      input.write("ic07", 8);
      input.writeUInt32BE(0, 12);
      assert.throws(() => ICNS.calculate(input), /Invalid ICNS image entry length/);
    `,
    "ICNS zero-length entry proof",
  );
});

test("patched image-size rejects a zero-length JXL target box", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { JXL } = require(${JSON.stringify(jxlModulePath)});
      const input = Buffer.alloc(8);
      input.write("jxlp", 4);
      assert.throws(() => JXL.calculate(input), /Invalid JXL/);
    `,
    "JXL zero-length target box proof",
  );
});

test("patched image-size rejects a zero-length HEIF target box", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { HEIF } = require(${JSON.stringify(heifModulePath)});
      const input = Buffer.alloc(8);
      input.write("meta", 4);
      assert.throws(() => HEIF.calculate(input), /Invalid HEIF/);
    `,
    "HEIF zero-length target box proof",
  );
});

test("patched image-size never returns an undersized target box", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { findBox } = require(${JSON.stringify(utilsModulePath)});
      const input = Buffer.alloc(8);
      input.write("meta", 4);
      assert.equal(findBox(input, "meta", 0), undefined);
    `,
    "undersized target box proof",
  );
});

test("patched image-size rejects malformed ICNS bounds", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { ICNS } = require(${JSON.stringify(icnsModulePath)});

      const truncatedHeader = Buffer.alloc(12);
      truncatedHeader.write("icns", 0);
      truncatedHeader.writeUInt32BE(12, 4);
      assert.throws(() => ICNS.calculate(truncatedHeader), /Invalid ICNS image entry header/);

      const undersizedFile = Buffer.alloc(8);
      undersizedFile.write("icns", 0);
      undersizedFile.writeUInt32BE(4, 4);
      assert.throws(() => ICNS.calculate(undersizedFile), /Invalid ICNS file length/);

      const overflowingEntry = Buffer.alloc(16);
      overflowingEntry.write("icns", 0);
      overflowingEntry.writeUInt32BE(16, 4);
      overflowingEntry.write("ic07", 8);
      overflowingEntry.writeUInt32BE(20, 12);
      assert.throws(() => ICNS.calculate(overflowingEntry), /Invalid ICNS image entry length/);
    `,
    "ICNS malformed bounds proof",
  );
});

test("patched image-size preserves valid ICNS traversal", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { ICNS } = require(${JSON.stringify(icnsModulePath)});

      const singleEntry = Buffer.alloc(16);
      singleEntry.write("icns", 0);
      singleEntry.writeUInt32BE(16, 4);
      singleEntry.write("ic07", 8);
      singleEntry.writeUInt32BE(8, 12);
      assert.deepEqual(ICNS.calculate(singleEntry), { width: 128, height: 128 });

      const multipleEntries = Buffer.alloc(24);
      multipleEntries.write("icns", 0);
      multipleEntries.writeUInt32BE(24, 4);
      multipleEntries.write("ic07", 8);
      multipleEntries.writeUInt32BE(8, 12);
      multipleEntries.write("ic08", 16);
      multipleEntries.writeUInt32BE(8, 20);
      const result = ICNS.calculate(multipleEntries);
      assert.deepEqual(result.images.map((image) => image.type), ["ic07", "ic08"]);
    `,
    "valid ICNS traversal proof",
  );
});

test("patched image-size rejects truncated and overflowing boxes", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { findBox } = require(${JSON.stringify(utilsModulePath)});

      assert.equal(findBox(Buffer.alloc(7), "meta", 0), undefined);

      const overflowingBox = Buffer.alloc(8);
      overflowingBox.writeUInt32BE(16, 0);
      overflowingBox.write("meta", 4);
      assert.equal(findBox(overflowingBox, "meta", 0), undefined);
    `,
    "invalid box bounds proof",
  );
});

test("patched image-size preserves valid box lookup and traversal", async () => {
  await runBoundedProof(
    `
      const assert = require("node:assert/strict");
      const { findBox } = require(${JSON.stringify(utilsModulePath)});

      const targetBox = Buffer.alloc(8);
      targetBox.writeUInt32BE(8, 0);
      targetBox.write("meta", 4);
      assert.deepEqual(findBox(targetBox, "meta", 0), { name: "meta", offset: 0, size: 8 });

      const traversedBoxes = Buffer.alloc(16);
      traversedBoxes.writeUInt32BE(8, 0);
      traversedBoxes.write("free", 4);
      traversedBoxes.writeUInt32BE(8, 8);
      traversedBoxes.write("meta", 12);
      assert.deepEqual(findBox(traversedBoxes, "meta", 0), { name: "meta", offset: 8, size: 8 });
    `,
    "valid box traversal proof",
  );
});

test("RN and Expo Metro asset paths independently preserve buffer and file dimensions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ling-metro-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "logo.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6cAAAAASUVORK5CYII=", "base64");
  await writeFile(filename, png);
  for (const dependencyRequire of [metroRequire, createRequire(expoRequire.resolve("metro/package.json"))]) {
    const assets = dependencyRequire("./src/Assets.js");
    assert.deepEqual(assets.getAssetSize("png", png, filename), { width: 1, height: 1 });
    const data = await assets.getAssetData(filename, "logo.png", [], null, "/assets");
    assert.equal(data.width, 1);
    assert.equal(data.height, 1);
    assert.equal(data.hash.length, 32);
    assert.equal(data.type, "png");
    assert.deepEqual(data.files, [filename]);
    assert.throws(() => assets.getAssetSize("png", Buffer.alloc(0), filename), /empty file/);
  }
});

test("image-size ESM exports also reject malformed ICNS, JXL and HEIF", async () => {
  await runBoundedProof(
    `
      (async () => {
        const assert = require("node:assert/strict");
        const icns = await import(${JSON.stringify(icnsModulePath.replace("/cjs/", "/esm/"))});
        const jxl = await import(${JSON.stringify(jxlModulePath.replace("/cjs/", "/esm/"))});
        const heif = await import(${JSON.stringify(heifModulePath.replace("/cjs/", "/esm/"))});
        for (const length of [0, 20]) {
          const input = Buffer.alloc(16);
          input.write("icns", 0);
          input.writeUInt32BE(16, 4);
          input.write("ic07", 8);
          input.writeUInt32BE(length, 12);
          assert.throws(() => icns.ICNS.calculate(input), /Invalid ICNS image entry length/);
        }
        const box = Buffer.alloc(8);
        box.write("jxlp", 4);
        assert.throws(() => jxl.JXL.calculate(box), /Invalid JXL/);
        box.write("meta", 4);
        assert.throws(() => heif.HEIF.calculate(box), /Invalid HEIF/);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
    "ESM malformed image proof",
  );
});
