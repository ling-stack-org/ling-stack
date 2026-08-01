import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("permission preset selection has no browser confirmation owner", async () => {
  const source = await readFile(new URL("../dist/composer/ComposerPermissionMenu.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /globalThis\.confirm|window\.confirm/u);
  assert.doesNotMatch(source, /confirmChange|fullAccessConfirmationMessage/u);
  assert.match(source, /onPresetChange\(nextPreset\)/u);
});

test("permission trigger owns one compact muted presentation for every composer", async () => {
  const styles = await readFile(new URL("../dist/styles/composer/conversation-composer.css", import.meta.url), "utf8");

  assert.match(styles, /\.conversation-authorization-trigger\s*\{[^}]*color:\s*var\(--ling-text-muted\)/su);
  assert.match(styles, /\.conversation-authorization-trigger\s*\{[^}]*font-size:\s*var\(--ling-font-xs\)/su);
  assert.match(styles, /\.conversation-authorization-trigger\s*\{[^}]*font-weight:\s*500/su);
});
