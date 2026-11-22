import { createHash } from "node:crypto";
import type { LingAppServerGitHubSubject, LingGitHubCiEvidence, LingGitHubRequiredCheck } from "@ling-stack/contracts";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import { commitSha, digest, readAppServerGitHubSubject, type GitHubReadClient } from "./app-server-github-subject.js";

/** Reconcile checks through their provider-owned App, workflow, latest run and attempt. */
export async function observeGitHubDelivery(client: GitHubReadClient, pullRequestNumber: number) {
  const params = { repository: client.source.repository, kind: "pull_request" as const, number: pullRequestNumber };
  const subject = await readAppServerGitHubSubject(client, params);
  const policy = client.source.deliveryPolicies?.find(item => item.baseRef === subject.baseRef);
  if (!policy) throw new HttpError(409, "github_delivery_policy_missing", "The pull request has no registered delivery policy.");
  const readBase = () => readDeliveryBase(client, subject);
  const { baseCommit, integrationCommit, mergedCommit } = await readBase();
  const reads = new Map<string, Promise<Record<string, unknown>>>();
  const get = (path: string) => {
    let result = reads.get(path);
    if (!result) {
      result = client.get(path);
      reads.set(path, result);
    }
    return result;
  };
  const checks = await Promise.all(policy.requiredChecks.map(async check => {
    if (check.basis === "merge_group") return unavailable(check, "merge_group_membership_unavailable");
    const testedCommit = check.basis === "head" ? subject.headSha : integrationCommit;
    if (!testedCommit) return unavailable(check, "integration_unavailable");
    return readCurrentCheck(get, client.source.repository, check, testedCommit);
  }));
  // The effective attempt and PR basis must still match after the separate evidence reads.
  const [current, currentBase] = await Promise.all([readAppServerGitHubSubject(client, params), readBase()]);
  if (current.sourceRevision !== subject.sourceRevision || currentBase.baseCommit !== baseCommit
    || currentBase.integrationCommit !== integrationCommit) {
    throw new HttpError(409, "stale_revision", "The GitHub delivery basis changed during reconciliation.");
  }
  const boundRuns = new Map(checks.flatMap(check => check.runId && check.runAttempt
    ? [[check.runId, check.runAttempt] as const] : []));
  await Promise.all([...boundRuns].map(async ([runId, attempt]) => {
    const currentRun = await client.get(`/actions/runs/${runId}`);
    if (currentRun.id !== runId || currentRun.run_attempt !== attempt) {
      throw new HttpError(409, "stale_revision", "A GitHub workflow attempt changed during reconciliation.");
    }
  }));
  const status = checks.some(item => item.outcome === "failed") ? "ci_failed"
    : checks.some(item => item.outcome !== "passed") ? "ci_pending"
      : mergedCommit ? "delivered" : "delivery_pending";
  return {
    subject, baseCommit, checks, status, mergedCommit,
    policyRevision: digest([client.source.repositoryId, policy]),
  } as const;
}

async function readDeliveryBase(client: GitHubReadClient, subject: LingAppServerGitHubSubject) {
  if (subject.merged && subject.mergeSha) {
    const parents = await commitParents(client, subject.mergeSha);
    if (!parents?.[0]) throw new HttpError(502, "github_observation_invalid", "GitHub did not confirm the merged commit.");
    return { baseCommit: parents[0], mergedCommit: subject.mergeSha,
      integrationCommit: parents.length === 2 && parents[1] === subject.headSha ? subject.mergeSha : undefined };
  }
  const escapedRef = subject.baseRef!.split("/").map(encodeURIComponent).join("/");
  const ref = await client.get(`/git/ref/heads/${escapedRef}`);
  const baseCommit = isRecord(ref.object) && ref.object.type === "commit" ? commitSha(ref.object.sha) : undefined;
  if (!baseCommit || ref.ref !== `refs/heads/${subject.baseRef}`) {
    throw new HttpError(502, "github_observation_invalid", "GitHub did not confirm the current base branch.");
  }
  const parents = subject.mergeSha && subject.state === "open" ? await commitParents(client, subject.mergeSha) : undefined;
  return { baseCommit, mergedCommit: undefined,
    integrationCommit: parents?.length === 2 && parents[0] === baseCommit && parents[1] === subject.headSha ? subject.mergeSha : undefined };
}

async function commitParents(client: GitHubReadClient, oid: string): Promise<readonly string[] | undefined> {
  let commit: Record<string, unknown>;
  try { commit = await client.get(`/git/commits/${oid}`); } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return undefined;
    throw error;
  }
  if (commit.sha !== oid || !Array.isArray(commit.parents)) return undefined;
  const parents = commit.parents.map(parent => isRecord(parent) ? commitSha(parent.sha) : undefined);
  return parents.every((parent): parent is string => parent !== undefined) ? parents : undefined;
}

function unavailable(check: LingGitHubRequiredCheck, reason: NonNullable<LingGitHubCiEvidence["reason"]>): LingGitHubCiEvidence {
  return { check, outcome: "unavailable", reason };
}

async function readCurrentCheck(
  get: GitHubReadClient["get"], repository: string, check: LingGitHubRequiredCheck, testedCommit: string,
): Promise<LingGitHubCiEvidence> {
  const runs = await get(`/actions/workflows/${check.workflowId}/runs?head_sha=${testedCommit}&per_page=100`);
  const workflowRuns = boundedRecords(runs, "workflow_runs");
  if (!workflowRuns) return unavailable(check, "observation_window_exceeded");
  const applicable = workflowRuns.filter(run => run.workflow_id === check.workflowId && run.head_sha === testedCommit)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
  const run = applicable[0];
  if (!run) return { check, testedCommit, outcome: "pending", reason: "applicable_check_missing" };
  const runId = positiveId(run.id);
  const runAttempt = positiveId(run.run_attempt);
  if (!runId || !runAttempt || typeof run.created_at !== "string") return unavailable(check, "ambiguous_run");
  const proof = { check, testedCommit, runId, runAttempt };
  if (run.status !== "completed") return { ...proof, outcome: "pending", reason: "current_attempt_pending" };
  if (typeof run.path !== "string" || run.path.split("@", 1)[0] !== check.workflowPath
    || !["push", "pull_request", "workflow_dispatch"].includes(String(run.event))) {
    return { ...proof, outcome: "unavailable", reason: "workflow_source_changed" };
  }
  const [jobs, checks, workflow] = await Promise.all([
    get(`/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`),
    get(`/commits/${testedCommit}/check-runs?per_page=100&filter=latest`),
    get(`/contents/${check.workflowPath}?ref=${testedCommit}`).catch(error => {
      if (error instanceof HttpError && error.statusCode === 404) return undefined;
      throw error;
    }),
  ]);
  if (workflow?.type !== "file" || workflow.path !== check.workflowPath || workflow.encoding !== "base64"
    || typeof workflow.content !== "string" || workflow.content.length > 128 * 1024
    || createHash("sha256").update(Buffer.from(workflow.content, "base64")).digest("hex") !== check.workflowSha256) {
    return { ...proof, outcome: "unavailable", reason: "workflow_source_changed" };
  }
  const jobRecords = boundedRecords(jobs, "jobs");
  const checkRecords = boundedRecords(checks, "check_runs");
  if (!jobRecords || !checkRecords) return unavailable(check, "observation_window_exceeded");
  const matchingJobs = jobRecords.filter(job => job.name === check.name && job.run_id === runId && job.head_sha === testedCommit);
  const job = matchingJobs[0];
  const jobId = positiveId(job?.id);
  if (matchingJobs.length !== 1 || !jobId) {
    return { ...proof, outcome: "pending", reason: "applicable_check_missing" };
  }
  const matched = checkRecords.filter(run => run.name === check.name && run.head_sha === testedCommit
    && isRecord(run.app) && run.app.id === check.appId && positiveId(run.id) !== undefined
    && typeof job.check_run_url === "string"
    && job.check_run_url.toLowerCase() === `https://api.github.com/repos/${repository}/check-runs/${run.id}`
    && run.url === job.check_run_url);
  const checkRunId = positiveId(matched[0]?.id);
  if (matched.length !== 1 || !checkRunId) return { ...proof, outcome: "pending", reason: "applicable_check_missing" };
  const evidence = { ...proof, checkRunId, jobId };
  const confirmed = matched[0]!;
  if (job.status !== "completed" || confirmed.status !== "completed" || !job.conclusion || confirmed.conclusion !== job.conclusion) {
    return { ...evidence, outcome: "pending", reason: "current_attempt_pending" };
  }
  return { ...evidence, outcome: job.conclusion === "success" ? "passed" : "failed" };
}

function boundedRecords(value: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const values = value[key];
  if (!Array.isArray(values) || typeof value.total_count !== "number" || value.total_count > values.length
    || values.length > 100 || !values.every(isRecord)) return undefined;
  return values;
}

function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
