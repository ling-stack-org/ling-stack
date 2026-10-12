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

test("PPT generation resolves fixed image-size and writes image relationships", async () => {
  const pptxRequire = createRequire(localRequire.resolve("pptxgenjs"));
  const imageSizeRequire = createRequire(pptxRequire.resolve("image-size"));
  assert.equal(imageSizeRequire("../../package.json").version, "2.0.4");
  const PptxGenJS = localRequire("pptxgenjs");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR6cAAAAASUVORK5CYII=";
  assert.deepEqual(pptxRequire("image-size").imageSize(Buffer.from(png, "base64")), {
    width: 1, height: 1, type: "png",
  });
  const presentation = new PptxGenJS();
  const slide = presentation.addSlide();
  slide.addImage({ data: `image/png;base64,${png}`, x: 1, y: 1, w: 2, h: 2 });
  const output = await presentation.write({ outputType: "nodebuffer" });
  const zip = await pptxRequire("jszip").loadAsync(output);
  assert.ok(zip.file("ppt/media/image-1-1.png"));
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(xml, /<p:pic>/);
  const relationships = await zip.file("ppt/slides/_rels/slide1.xml.rels").async("string");
  assert.match(relationships, /relationships\/image/);
});
