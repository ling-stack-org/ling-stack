import assert from "node:assert/strict";
import test from "node:test";
import { formatEditPreview } from "../dist/features/runs/edit-diff-preview.js";

test("bounded approval preview prefixes each line and discloses omitted text", () => {
  assert.equal(formatEditPreview([{ oldText: "a\nb\nc", newText: "x\ny\nz" }], { maxTextCharacters: 3 }),
    "#1\n- a\n- b\n[truncated old edit preview: 2 characters omitted]\n+ x\n+ y\n[truncated new edit preview: 2 characters omitted]");
});

test("blank lines and deletion-only edits have physical-line counts", () => {
  assert.equal(formatEditPreview([{ oldText: "\nold\n", newText: "" }]), "#1\n- \n- old");
  assert.equal(formatEditPreview([{ oldText: "", newText: "\n" }]), "#1\n+ ");
});

test("multiple edits preserve ordered blocks and do not invent file coordinates", () => {
  const preview = formatEditPreview([{ oldText: "first", newText: "second" }, null, { oldText: "third", newText: "fourth" }]);
  assert.equal(preview, "#1\n- first\n+ second\n\n#2\n<invalid edit entry>\n\n#3\n- third\n+ fourth");
  assert.doesNotMatch(preview, /^@@/m);
  assert.equal(formatEditPreview([]), "No edit preview was provided.");
});

test("approval preview clipping keeps supplementary Unicode intact", () => {
  const preview = formatEditPreview([{ oldText: "", newText: "ab🙂cd" }], { maxTextCharacters: 3 });
  assert.equal(preview, "#1\n+ ab\n[truncated new edit preview: 4 characters omitted]");
  assert.doesNotMatch(preview, /[\ud800-\udfff]/u);
  assert.throws(() => formatEditPreview([], { maxTextCharacters: 0 }), RangeError);
});
