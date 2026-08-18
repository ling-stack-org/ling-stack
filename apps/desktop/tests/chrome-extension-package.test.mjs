import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Desktop package carries the deterministic Chrome extension without install authority", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const resources = packageJson.build.extraResources;
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/ling-for-chrome.zip" && entry.to === "browser-extension/ling-for-chrome.zip"), true);
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/dist/build-metadata.json"), true);
  assert.equal(resources.some((entry) => entry.from === "../chrome-extension/STORE_SUBMISSION.md"), true);
  assert.equal(resources.some((entry) => entry.from === "../../LICENSE" && entry.to === "browser-extension/LICENSE"), true);
  assert.match(packageJson.scripts.build, /@ling-stack\/chrome-extension build/u);
  assert.equal(JSON.stringify(packageJson).includes("NativeMessagingHosts"), false);
  assert.equal(JSON.stringify(packageJson).includes("ExtensionInstallForcelist"), false);
});
