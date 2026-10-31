import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";

/** Log ids are display joins only; the existing Host viewer validates ownership. */
export function commandLogEvidence(item: ConversationTimelineCommandExecutionItem) {
  const seen = new Set<string>();
  return ([
    ["stdout", item.stdoutArtifactId],
    ["stderr", item.stderrArtifactId],
    ["result", item.resultArtifactId],
  ] as const).flatMap(([stream, id]) => {
    if (!id || seen.has(id)) return [];
    const ref = item.sourceRefs.find(candidate => candidate.kind === "artifact" && candidate.id === id);
    if (!ref) return [];
    seen.add(id);
    return [{ stream, ref }];
  });
}
