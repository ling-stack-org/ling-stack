import type { ConversationDiffDisplayLine, ConversationDiffDisplayRow } from "./diff-summary.js";

export type SplitDiffDisplayRow = ConversationDiffDisplayRow | {
  readonly type: "split";
  readonly id: string;
  readonly oldLine?: ConversationDiffDisplayLine;
  readonly newLine?: ConversationDiffDisplayLine;
};

/** Align each contiguous changed block by position; context retains both revision locations. */
export function splitDiffRows(rows: readonly ConversationDiffDisplayRow[]): readonly SplitDiffDisplayRow[] {
  const result: SplitDiffDisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.type === "fold" || row.line.kind === "meta" || row.line.kind === "hunk") {
      result.push(row);
      index++;
    } else if (row.line.kind === "context") {
      result.push({ type: "split", id: row.id, oldLine: row.line, newLine: row.line });
      index++;
    } else {
      const deleted: { id: string; line: ConversationDiffDisplayLine }[] = [];
      const added: { id: string; line: ConversationDiffDisplayLine }[] = [];
      while (index < rows.length) {
        const changed = rows[index]!;
        if (changed.type !== "line" || changed.line.kind !== "delete" && changed.line.kind !== "add") break;
        (changed.line.kind === "delete" ? deleted : added).push(changed);
        index++;
      }
      for (let line = 0; line < Math.max(deleted.length, added.length); line++) {
        result.push({ type: "split", id: `split:${deleted[line]?.id ?? ""}:${added[line]?.id ?? ""}`,
          ...(deleted[line] ? { oldLine: deleted[line]!.line } : {}),
          ...(added[line] ? { newLine: added[line]!.line } : {}) });
      }
    }
  }
  return result;
}
