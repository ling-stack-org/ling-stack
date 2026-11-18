import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCreateCodeAssessmentComment, type CodeAssessmentDetail } from "@ling-stack/contracts";
import type { CodeAssessmentCommentsStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

/** The caller performs workspace authorization and resolves the assessment before dispatch. */
export async function handleCodeAssessmentCommentRequest(request: IncomingMessage, response: ServerResponse,
  store: CodeAssessmentCommentsStore, detail: CodeAssessmentDetail, findingId: string): Promise<void> {
  if (!detail.findings.some(finding => finding.id === findingId)) throw new HttpError(404, "finding_not_found", "Finding not found.");
  if (request.method === "GET") {
    writeJson(response, 200, { comments: store.listCodeAssessmentComments(detail.assessment.id, findingId) });
  } else if (request.method === "POST") {
    const input = parseCreateCodeAssessmentComment(await readJsonBody(request, 24 * 1024));
    if (input.snapshotDigest !== detail.snapshot.digest) throw new HttpError(409, "snapshot_changed", "Comment snapshot does not match.");
    writeJson(response, 201, store.createCodeAssessmentComment(detail.assessment.id, findingId,
      { ...input, id: `comment_${randomUUID()}`, now: new Date().toISOString() }));
  } else {
    writeJson(response, 405, { error: "method_not_allowed" });
  }
}
