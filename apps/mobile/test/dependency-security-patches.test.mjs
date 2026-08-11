import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const localRequire = createRequire(import.meta.url);
const expoRequire = createRequire(localRequire.resolve("expo/package.json"));
const imageSizeRequire = createRequire(expoRequire.resolve("image-size/package.json"));
const imageSizeManifest = imageSizeRequire("./package.json");
const heifModulePath = imageSizeRequire.resolve("./dist/types/heif.js");
const icnsModulePath = imageSizeRequire.resolve("./dist/types/icns.js");
const jxlModulePath = imageSizeRequire.resolve("./dist/types/jxl.js");
const utilsModulePath = imageSizeRequire.resolve("./dist/types/utils.js");

assert.equal(imageSizeManifest.version, "1.2.1");

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
      assert.throws(() => JXL.calculate(input), /No codestream found/);
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
      assert.throws(() => HEIF.calculate(input), /Invalid HEIF, no size found/);
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
      assert.deepEqual(ICNS.calculate(singleEntry), { width: 128, height: 128, type: "ic07" });

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
