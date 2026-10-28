import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStore } from "@ling-stack/core";
import type { LearningReviewLimits } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { captureLearningEvidence } from "./evidence.js";
import type { LearningReviewCoordinator } from "./coordinator.js";

export async function handleLearningReviewRoute(input: {
  readonly request: IncomingMessage; readonly response: ServerResponse; readonly url: URL;
  readonly config: ResolvedDaemonConfig; readonly getStore: (cwd: string) => RunStore;
  readonly coordinator?: LearningReviewCoordinator;
}): Promise<void> {
  const { request, response, url } = input;
  const cwd = url.searchParams.get("cwd");
  if (!cwd) { writeJson(response, 400, { error: "cwd_required" }); return; }
  const store = input.getStore(cwd);
  try {
    if (url.pathname === "/skills/learning-policy") {
      if (request.method === "GET") { writeJson(response, 200, { cwd, policy: store.getLearningReviewPolicy() }); return; }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, input.config.maxBodyBytes);
        if (!isRecord(body) || !["off", "propose"].includes(String(body.mode)) || !Number.isSafeInteger(body.expectedRevision)) throw new Error("learning_policy_invalid");
        const providerPresetId = typeof body.providerPresetId === "string" ? body.providerPresetId : undefined;
        if (body.limits !== undefined && !isRecord(body.limits)) throw new Error("learning_limits_invalid");
        if (body.mode === "propose" && (!providerPresetId || !store.getProviderPreset(providerPresetId)?.enabled)) throw new Error("learning_provider_unavailable");
        const policy = store.updateLearningReviewPolicy({ mode: body.mode as "off" | "propose", providerPresetId,
          expectedRevision: Number(body.expectedRevision), limits: body.limits as Partial<LearningReviewLimits> | undefined }, new Date().toISOString());
        input.coordinator?.wake(store);
        writeJson(response, 200, { cwd, policy }); return;
      }
    } else if (url.pathname === "/skills/learning-reviews") {
      if (request.method === "GET") { writeJson(response, 200, { cwd, jobs: store.listLearningReviewJobs() }); return; }
      if (request.method === "POST") {
        const body = await readJsonBody(request, input.config.maxBodyBytes);
        if (!isRecord(body) || typeof body.runId !== "string" || typeof body.providerPresetId !== "string" ||
          (body.correction !== undefined && (typeof body.correction !== "string" || body.correction.length > 4000))) throw new Error("learning_request_invalid");
        const preset = store.getProviderPreset(body.providerPresetId);
        if (!preset?.enabled || !preset.capabilities.includes("chat")) throw new Error("learning_provider_unavailable");
        const governance = store.getWorkspaceSettings().skillGovernancePolicy;
        if (governance.generationMode === "off" || governance.recordingMode !== "user_initiated") throw new Error("learning_generation_disabled");
        const evidence = captureLearningEvidence(store, body.runId, body.correction as string | undefined);
        if (body.correction && !evidence.selectedSkillId) throw new Error("learning_correction_skill_missing");
        const job = store.enqueueLearningReview({ mode: "explicit", evidence, providerPresetId: body.providerPresetId }, new Date().toISOString());
        input.coordinator?.wake(store);
        writeJson(response, 202, { cwd, job }); return;
      }
    } else {
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments.length === 3 && request.method === "GET") {
        const job = store.getLearningReviewJob(segments[2]!);
        writeJson(response, job ? 200 : 404, job ? { cwd, job } : { error: "learning_job_not_found" }); return;
      }
      if (segments.length === 4 && segments[3] === "cancel" && request.method === "POST") {
        const job = store.cancelLearningReviewJob(segments[2]!, "learning_cancelled_by_user", new Date().toISOString());
        writeJson(response, job ? 200 : 404, job ? { cwd, job } : { error: "learning_job_not_found" }); return;
      }
    }
    writeJson(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    const code = error instanceof Error && /^learning_[a-z_0-9]+$/.test(error.message) ? error.message : "learning_request_failed";
    writeJson(response, code.endsWith("conflict") ? 409 : 400, { error: code });
  }
}
