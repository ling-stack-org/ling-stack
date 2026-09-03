import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

const localRequire = createRequire(import.meta.url);

test("officeparser resolves a non-vulnerable pdfjs-dist version", () => {
  const officeParserEntry = localRequire.resolve("officeparser");
  const officeParserRequire = createRequire(resolve(dirname(officeParserEntry), "..", "package.json"));
  const pdfjsEntry = officeParserRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsPackage = JSON.parse(readFileSync(resolve(dirname(pdfjsEntry), "..", "..", "package.json"), "utf8"));
  assert.equal(pdfjsPackage.version, "6.2.108");
});
