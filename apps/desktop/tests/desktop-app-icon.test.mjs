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
    include: "build/installer.nsh",
  });
  const installer = await readFile(resolve(desktopRoot, packageJson.build.nsis.include), "utf8");
  assert.match(installer, /DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com\.lingstack\.browser"/u);
  assert.match(installer, /DeleteRegKey HKCU "Software\\Chromium\\NativeMessagingHosts\\com\.lingstack\.browser"/u);

  const icns = await readFile(resolve(desktopRoot, packageJson.build.mac.icon));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const representations = new Map();
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString("ascii", offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= icns.length);
    assert.ok(!representations.has(type));
    representations.set(type, icns.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.equal(representations.size, 10);
  const fullResolution = representations.get("ic10");
  assert.equal(fullResolution.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(fullResolution.readUInt32BE(16), 1024);
  assert.equal(fullResolution.readUInt32BE(20), 1024);

  const ico = await readFile(resolve(desktopRoot, packageJson.build.win.icon));
  assert.deepEqual(
    inspectIcoFrames(ico).map(({ width, height, bitCount }) => ({ width, height, bitCount })),
    LING_ICON_SIZES.map((size) => ({ width: size, height: size, bitCount: 32 })),
  );
});
