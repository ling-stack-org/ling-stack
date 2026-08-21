import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Desktop package carries the deterministic Chrome extension and Native Host", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const installer = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  const resources = packageJson.build.extraResources;
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/ling-for-chrome.zip" && entry.to === "browser-extension/ling-for-chrome.zip"), true);
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/dist/build-metadata.json"), true);
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/STORE_SUBMISSION.md"), true);
  assert.equal(resources.some((entry) => entry.from === "../../LICENSE" && entry.to === "browser-extension/LICENSE"), true);
  const hostResource = resources.find((entry) => entry.from === "../../packages/browser-host/dist/native" && entry.to === "browser-host");
  assert.deepEqual(hostResource?.filter, ["ling-browser-host", "ling-browser-host.exe", "build-metadata.json"]);
  const packageFiles = packageJson.build.files;
  for (const excludedPath of ["dist/native", "native", "scripts", "src", "test"]) {
    assert.equal(
      packageFiles.includes(`!**/node_modules/@ling-stack/browser-host/${excludedPath}{,/**/*}`),
      true,
      `Desktop package must exclude duplicate Browser Host ${excludedPath}`,
    );
  }
  assert.equal(packageFiles.includes("!**/node_modules/@ling-stack/browser-host/tsconfig.json"), true);
  assert.match(packageJson.scripts.build, /@ling-stack\/chrome-extension build/u);
  assert.match(packageJson.scripts.build, /@ling-stack\/browser-host build/u);
  assert.match(packageJson.scripts["package:mac"], /@ling-stack\/browser-host build:native/u);
  assert.match(packageJson.scripts["package:win"], /@ling-stack\/browser-host build:native/u);
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.match(installer, /DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com\.lingstack\.browser"/u);
  assert.match(installer, /DeleteRegKey HKCU "Software\\Chromium\\NativeMessagingHosts\\com\.lingstack\.browser"/u);
  assert.match(installer, /Delete "\$LOCALAPPDATA\\Ling Stack\\browser-host\\com\.lingstack\.browser\.json"/u);
  assert.equal(JSON.stringify(packageJson).includes("ExtensionInstallForcelist"), false);
});
