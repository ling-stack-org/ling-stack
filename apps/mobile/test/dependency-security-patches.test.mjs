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
