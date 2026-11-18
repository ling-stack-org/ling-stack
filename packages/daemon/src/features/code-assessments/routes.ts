import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCreateCodeAssessment } from "@ling-stack/contracts";
import type { CodeAssessmentDetail, CodeAssessmentFreshness, CodeAssessmentListOptions, CodeFindingCloseReason, CodeFindingDisposition } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { HttpError } from "../../errors.js";
import { captureCodeAssessmentSnapshot } from "./snapshot.js";
import { cancelCodeAssessment, reconcileCodeAssessments, startCodeAssessment, type StartCodeAssessmentRun } from "./service.js";
import { codeAssessmentOverview } from "./overview.js";
import { handleCodeAssessmentCommentRequest } from "./comments.js";

export interface CodeAssessmentRouteDependencies {
  readonly storeRegistry: RunStoreRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly startRun: StartCodeAssessmentRun;
}

function requireDetail(detail: CodeAssessmentDetail | undefined): CodeAssessmentDetail {
  if (!detail) throw new HttpError(404, "assessment_not_found", "Assessment not found.");
  return detail;
}

async function checkFreshness(cwd: string, detail: CodeAssessmentDetail): Promise<CodeAssessmentFreshness> {
  let state: CodeAssessmentFreshness["state"] = "unknown";
  try {
    const current = await captureCodeAssessmentSnapshot(cwd, detail.snapshot.target);
    if (current.digest !== detail.snapshot.digest) state = "stale";
    else if (detail.snapshot.coverage === "complete" && current.coverage === "complete") state = "current";
  } catch { /* A moving or unavailable repository cannot certify freshness. */ }
  return { state, checkedAt: new Date().toISOString() };
}

function listOptions(url: URL): CodeAssessmentListOptions {
  const input: Record<string, string | number> = {};
  const enums = {
    kind: ["review", "security"], targetType: ["working_tree", "branch", "commit"],
    status: ["queued", "analyzing", "completed", "partial", "failed", "cancelled", "interrupted"],
    severity: ["critical", "high", "medium", "low", "info"], confidence: ["high", "medium", "low"],
  };
  for (const [key, values] of Object.entries(enums)) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    if (!values.includes(value)) throw new HttpError(400, "invalid_assessment_filter", `${key} is not a supported assessment filter.`);
    input[key] = value;
  }
  const digest = url.searchParams.get("snapshotDigest");
  if (digest !== null) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new HttpError(400, "invalid_assessment_filter", "snapshotDigest must be a SHA-256 digest.");
    input.snapshotDigest = digest;
  }
  for (const key of ["updatedAfter", "updatedBefore"]) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new HttpError(400, "invalid_assessment_filter", `${key} must be an ISO timestamp with a timezone.`);
    }
    input[key] = new Date(value).toISOString();
  }
  if (input.updatedAfter && input.updatedBefore && input.updatedAfter > input.updatedBefore) throw new HttpError(400, "invalid_assessment_filter", "The updated time range is reversed.");
  return { ...input, limit: readOptionalIntegerQuery(url, "limit", 1), offset: readOptionalIntegerQuery(url, "offset", 0) } as CodeAssessmentListOptions;
}

export async function handleCodeAssessmentRoutes(request: IncomingMessage, response: ServerResponse, url: URL, dependencies: CodeAssessmentRouteDependencies): Promise<boolean> {
  const route = /^\/workspace\/code-assessments(?:\/([^/]+)(?:\/(cancel|freshness|snapshot-file)|\/findings\/([^/]+)(\/comments)?)?)?$/u.exec(url.pathname);
  if (!route) return false;
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) { writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" }); return true; }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: dependencies.storeRegistry, cwd })) return true;
  const store = dependencies.storeRegistry.getInitializedStore(cwd);
  if (!store) { writeJson(response, 404, { error: "workspace_not_loaded", message: "Open this project before using code assessments." }); return true; }
  try {
    const id = route[1] ? decodeURIComponent(route[1]) : undefined;
    const findingId = route[3] ? decodeURIComponent(route[3]) : undefined;
    const project = (detail: CodeAssessmentDetail) => url.searchParams.get("view") === "overview" ? codeAssessmentOverview(detail) : detail;
    reconcileCodeAssessments(store, dependencies.activeRuns);
    if (!id && request.method === "GET") {
      writeJson(response, 200, store.listCodeAssessments(listOptions(url)));
    } else if (!id && request.method === "POST") {
      const input = parseCreateCodeAssessment(await readJsonBody(request, 16 * 1024));
      writeJson(response, 202, project(await startCodeAssessment(store, input, dependencies.startRun)));
    } else if (id && !route[2] && !findingId && request.method === "GET") {
      writeJson(response, 200, project(requireDetail(store.getCodeAssessment(id))));
    } else if (id && route[2] === "snapshot-file" && request.method === "GET") {
      const detail = requireDetail(store.getCodeAssessment(id));
      const file = detail.snapshot.files.find(file => file.path === url.searchParams.get("path"));
      if (!file) throw new HttpError(404, "snapshot_file_not_found", "File is not part of the captured snapshot.");
      writeJson(response, 200, { snapshotDigest: detail.snapshot.digest, file });
    } else if (id && findingId && route[4]) {
      await handleCodeAssessmentCommentRequest(request, response, store, requireDetail(store.getCodeAssessment(id)), findingId);
    } else if (id && route[2] === "freshness" && request.method === "POST") {
      const detail = requireDetail(store.getCodeAssessment(id));
      writeJson(response, 200, store.recordCodeAssessmentFreshness(id, await checkFreshness(store.paths.cwd, detail)));
    } else if (id && route[2] === "cancel" && request.method === "POST") {
      writeJson(response, 200, cancelCodeAssessment(store, dependencies.activeRuns, requireDetail(store.getCodeAssessment(id))));
    } else if (id && findingId && request.method === "POST") {
      const body: unknown = await readJsonBody(request, 8 * 1024);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_disposition", "Expected a finding disposition.");
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !["snapshotDigest", "disposition", "closeReason", "reason"].includes(key))
        || typeof input.snapshotDigest !== "string" || !["open", "acknowledged", "resolved", "dismissed"].includes(String(input.disposition))
        || input.closeReason !== undefined && !["false_positive", "accepted_risk", "not_reproducible", "duplicate", "out_of_scope"].includes(String(input.closeReason))
        || input.reason !== undefined && typeof input.reason !== "string") throw new HttpError(400, "invalid_disposition", "Finding disposition is invalid.");
      const detail = requireDetail(store.getCodeAssessment(id));
      if (!detail.findings.some(finding => finding.id === findingId)) throw new HttpError(404, "finding_not_found", "Finding not found.");
      if (detail.snapshot.digest !== input.snapshotDigest) throw new HttpError(409, "snapshot_changed", "Finding snapshot does not match.");
      if (input.disposition === "resolved") {
        const freshness = store.recordCodeAssessmentFreshness(id, await checkFreshness(store.paths.cwd, detail));
        if (freshness.state !== "current") throw new HttpError(409, "snapshot_not_current", "Resolving a finding requires a current snapshot freshness check.");
      }
      writeJson(response, 200, store.setCodeFindingDisposition(id, findingId, {
        snapshotDigest: input.snapshotDigest, disposition: input.disposition as CodeFindingDisposition, closeReason: input.closeReason as CodeFindingCloseReason | undefined,
        reason: input.reason as string | undefined, now: new Date().toISOString(),
      }));
    } else {
      writeJson(response, 405, { error: "method_not_allowed" });
    }
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "assessment_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
