import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectIcoFrames, LING_ICON_SIZES } from "./verify-windows-app-icons.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Desktop packaging uses Ling brand icons and an explicit per-user Windows policy", async () => {
  const packageJson = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));

  assert.equal(packageJson.build?.mac?.icon, "build/icon.icns");
  assert.equal(packageJson.build?.win?.icon, "build/icon.ico");
  assert.equal(packageJson.build?.win?.requestedExecutionLevel, "asInvoker");
  assert.deepEqual(packageJson.build?.nsis, {
    oneClick: true,
    perMachine: false,
    packElevateHelper: false,
  });

  const icns = await readFile(resolve(desktopRoot, packageJson.build.mac.icon));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.ok(icns.length > 1_000_000, "macOS icon must retain the full-resolution Ling artwork");

  const ico = await readFile(resolve(desktopRoot, packageJson.build.win.icon));
  assert.deepEqual(
    inspectIcoFrames(ico).map(({ width, height, bitCount }) => ({ width, height, bitCount })),
    LING_ICON_SIZES.map((size) => ({ width: size, height: size, bitCount: 32 })),
  );
});
