import type { CodeAssessmentDetail, CodeAssessmentOverview } from "@ling-stack/contracts";

export function codeAssessmentOverview(detail: CodeAssessmentDetail): CodeAssessmentOverview {
  return {
    ...detail,
    snapshot: {
      ...detail.snapshot,
      files: detail.snapshot.files.map(({ diff, ...file }) => {
        let additions = 0, deletions = 0;
        let inHunk = false;
        for (const line of diff.split("\n")) {
          if (line.startsWith("@@ ")) inHunk = true;
          else if (inHunk && line.startsWith("+")) additions++;
          else if (inHunk && line.startsWith("-")) deletions++;
        }
        return { ...file, additions, deletions };
      }),
    },
  };
}
