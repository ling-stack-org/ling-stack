import assert from "node:assert/strict";
import test from "node:test";
import { splitDiffRows } from "../src/lib/diff-split-rows.ts";
import { parseUnifiedDiffHunkRows, type ConversationDiffDisplayLineRow, type ConversationDiffDisplayRow } from "../src/lib/diff-summary.ts";

function line(id: string, kind: ConversationDiffDisplayLineRow["line"]["kind"], oldLineNumber?: number, newLineNumber?: number): ConversationDiffDisplayLineRow {
  return { type: "line", id, line: { kind, text: id, ...(oldLineNumber === undefined ? {} : { oldLineNumber }), ...(newLineNumber === undefined ? {} : { newLineNumber }) } };
}

test("split rows pair replacement blocks in order and leave excess lines on their owning side", () => {
  const rows = [line("old-one", "delete", 4), line("old-two", "delete", 5), line("new-one", "add", undefined, 4),
    line("context", "context", 6, 5), line("new-two", "add", undefined, 6), line("new-three", "add", undefined, 7)];
  const original = structuredClone(rows);
  const split = splitDiffRows(rows);
  assert.deepEqual(split.map(row => row.type === "split" ? [row.oldLine?.text, row.newLine?.text] : row.type), [
    ["old-one", "new-one"], ["old-two", undefined], ["context", "context"], [undefined, "new-two"], [undefined, "new-three"],
  ]);
  assert.equal(new Set(split.map(row => row.id)).size, split.length);
  assert.deepEqual(rows, original);
  assert.deepEqual(splitDiffRows(rows), split, "stable source rows yield stable render identities");
});

test("folds and metadata span the full width and prevent pairing across boundaries", () => {
  const fold = { type: "fold", id: "fold", hiddenLineCount: 20 } as const;
  const metadata = line("metadata", "meta");
  const hunk = line("hunk", "hunk");
  const rows: ConversationDiffDisplayRow[] = [line("delete", "delete", 1), fold, line("addition", "add", undefined, 22), metadata, hunk];
  const split = splitDiffRows(rows);
  assert.deepEqual(split.map(row => row.type === "split" ? [row.oldLine?.text, row.newLine?.text] : row), [
    ["delete", undefined], fold, [undefined, "addition"], metadata, hunk,
  ]);
});

test("real parsed hunks retain each revision's exact line numbers after alignment", () => {
  const parsed = parseUnifiedDiffHunkRows("@@ -1,4 +1,3 @@\n same\n-before one\n-before two\n+after\n tail\n@@ -10 +9 @@\n-last\n+next\n");
  assert.equal(parsed.structured, true);
  const rows = splitDiffRows(parsed.rows);
  const context = rows.find(row => row.type === "split" && row.oldLine?.text === "tail");
  assert.ok(context?.type === "split");
  assert.equal(context.oldLine?.oldLineNumber, 4);
  assert.equal(context.newLine?.newLineNumber, 3);
  const replacement = rows.find(row => row.type === "split" && row.oldLine?.text === "last");
  assert.ok(replacement?.type === "split");
  assert.equal(replacement.oldLine?.oldLineNumber, 10);
  assert.equal(replacement.newLine?.newLineNumber, 9);
  assert.equal(replacement.newLine?.text, "next");
  assert.equal(rows.some(row => row.type === "fold" && row.hiddenLineCount === 5), true);
});

test("empty and one-sided diffs retain every captured line without manufacturing a peer", () => {
  assert.deepEqual(splitDiffRows([]), []);
  for (const [kind, side] of [["delete", "oldLine"], ["add", "newLine"]] as const) {
    const source = [line("one", kind, kind === "delete" ? 1 : undefined, kind === "add" ? 1 : undefined)];
    const row = splitDiffRows(source)[0];
    assert.ok(row?.type === "split");
    assert.equal(row[side], source[0]!.line);
    assert.equal(side === "oldLine" ? row.newLine : row.oldLine, undefined);
  }
});
