import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("permission preset selection has no browser confirmation owner", async () => {
  const source = await readFile(new URL("../dist/composer/ComposerPermissionMenu.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /globalThis\.confirm|window\.confirm/u);
  assert.doesNotMatch(source, /confirmChange|fullAccessConfirmationMessage/u);
  assert.match(source, /onPresetChange\(nextPreset\)/u);
});
