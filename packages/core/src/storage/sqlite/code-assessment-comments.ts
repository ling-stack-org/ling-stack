import { assertCodeAssessmentLineAnchor, parseCreateCodeAssessmentComment,
  type CodeAssessmentComment } from "@ling-stack/contracts";
import type { CodeAssessmentCommentsStore } from "../../code-assessment-comments.js";
import type { CodeAssessmentStore } from "../../code-assessment-store.js";
import type { SqliteStoreContext } from "./store-context.js";

const maxCommentsPerFinding = 100;

export class SqliteCodeAssessmentCommentsStore implements CodeAssessmentCommentsStore {
  constructor(private readonly context: SqliteStoreContext, private readonly assessments: Pick<CodeAssessmentStore, "getCodeAssessment">) {}

  createCodeAssessmentComment(assessmentId: string, findingId: string,
    input: Parameters<CodeAssessmentCommentsStore["createCodeAssessmentComment"]>[2]): CodeAssessmentComment {
    const { id, now, ...request } = input;
    const parsed = parseCreateCodeAssessmentComment(request);
    if (!id || id.length > 200 || !Number.isFinite(Date.parse(now))) throw new Error("Comment identity or creation time is invalid.");
    const { detail, finding } = this.requireFinding(assessmentId, findingId);
    assertCodeAssessmentLineAnchor(parsed, detail.snapshot);
    if (finding.snapshotDigest !== parsed.snapshotDigest || finding.path !== parsed.path || finding.side !== parsed.side
      || finding.startLine !== parsed.startLine || finding.endLine !== parsed.endLine) throw new Error("Comment anchor does not match the finding.");
    const comment: CodeAssessmentComment = { ...parsed, id, assessmentId, findingId, createdAt: now };
    const result = this.context.database.prepare(`INSERT INTO code_assessment_comments(id,assessment_id,finding_id,created_at,body_json)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM code_assessment_comments WHERE assessment_id=? AND finding_id=?) < ?`)
      .run(id, assessmentId, findingId, now, JSON.stringify(comment), assessmentId, findingId, maxCommentsPerFinding);
    if (result.changes === 0) throw new Error("A finding supports at most 100 comments.");
    return comment;
  }

  listCodeAssessmentComments(assessmentId: string, findingId: string): readonly CodeAssessmentComment[] {
    this.requireFinding(assessmentId, findingId);
    return this.context.database.prepare("SELECT body_json FROM code_assessment_comments WHERE assessment_id=? AND finding_id=? ORDER BY created_at,id LIMIT ?")
      .all(assessmentId, findingId, maxCommentsPerFinding).map(row => JSON.parse(String((row as { body_json: string }).body_json)) as CodeAssessmentComment);
  }

  private requireFinding(assessmentId: string, findingId: string) {
    const detail = this.assessments.getCodeAssessment(assessmentId);
    if (!detail) throw new Error("Assessment not found.");
    const finding = detail.findings.find(item => item.id === findingId);
    if (!finding) throw new Error("Finding not found.");
    return { detail, finding };
  }
}
