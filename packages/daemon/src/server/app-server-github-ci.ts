import { createHash } from "node:crypto";
import type {
  LingAppServerGitHubDelivery,
  LingAppServerGitHubSubject,
  LingGitHubCiEvidence,
  LingGitHubMergeGroupEvidence,
  LingGitHubRequiredCheck,
} from "@ling-stack/contracts";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import { commitSha, digest, readAppServerGitHubSubject, type GitHubReadClient } from "./app-server-github-subject.js";

/** Reconcile checks through their provider-owned App, workflow, latest run and attempt. */
export async function observeGitHubDelivery(client: GitHubReadClient, pullRequestNumber: number, previous?: LingAppServerGitHubDelivery) {
  const params = { repository: client.source.repository, kind: "pull_request" as const, number: pullRequestNumber };
  const subject = await readAppServerGitHubSubject(client, params);
  const policy = client.source.deliveryPolicies?.find(item => item.baseRef === subject.baseRef);
  if (!policy) throw new HttpError(409, "github_delivery_policy_missing", "The pull request has no registered delivery policy.");
  const policyRevision = digest([client.source.repositoryId, policy]);
  const readBase = () => readDeliveryBase(client, subject);
  const { baseCommit, integrationCommit, mergedCommit, mergedTree } = await readBase();
  const requiresMergeGroup = policy.requiredChecks.some(check => check.basis === "merge_group");
  const readCurrentGroup = () => requiresMergeGroup && subject.state === "open"
    ? readQueueMembership(client, subject, baseCommit)
    : Promise.resolve(undefined);
  const currentGroup = await readCurrentGroup();
  const retainedGroup = mergedCommit && previous?.policyRevision === policyRevision
    && previous.subject.number === subject.number && previous.subject.repositoryId === subject.repositoryId
    && previous.subject.headSha === subject.headSha && previous.subject.baseRef === subject.baseRef
    && previous.mergeGroup?.baseCommit === baseCommit
    && (previous.mergeGroup.testedCommit === mergedCommit
      || (mergedTree && previous.mergeGroup.testedTree === mergedTree)) ? previous.mergeGroup : undefined;
  const mergeGroup = currentGroup ?? retainedGroup;
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
    if (check.basis === "merge_group" && !mergeGroup) return unavailable(check, "merge_group_membership_unavailable");
    const testedCommit = check.basis === "head" ? subject.headSha
      : check.basis === "merge_group" ? mergeGroup?.testedCommit : integrationCommit;
    if (!testedCommit) return unavailable(check, "integration_unavailable");
    return readCurrentCheck(get, client.source.repository, check, testedCommit);
  }));
  // The effective attempt and PR basis must still match after the separate evidence reads.
  const [current, currentBase, freshGroup] = await Promise.all([readAppServerGitHubSubject(client, params), readBase(), readCurrentGroup()]);
  if (current.sourceRevision !== subject.sourceRevision || currentBase.baseCommit !== baseCommit
    || currentBase.integrationCommit !== integrationCommit
    || freshGroup?.membershipProofRef !== currentGroup?.membershipProofRef) {
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
    subject, baseCommit, checks, status, mergedCommit, policyRevision, ...(mergeGroup ? { mergeGroup } : {}),
  } as const;
}

const mergeQueueMembership = `query LingMergeQueueMembership($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    fullDatabaseId nameWithOwner
    pullRequest(number: $number) {
      number headRefOid baseRefName isInMergeQueue
      mergeQueueEntry {
        id
        baseCommit { oid }
        headCommit { oid tree { oid } }
        pullRequest { number headRefOid baseRefName }
      }
    }
  }
}`;

async function readQueueMembership(
  client: GitHubReadClient, subject: LingAppServerGitHubSubject, baseCommit: string,
): Promise<LingGitHubMergeGroupEvidence | undefined> {
  const [owner, name] = client.source.repository.split("/");
  let observed: Record<string, unknown> | undefined;
  try {
    observed = await client.query(mergeQueueMembership, { owner: owner!, name: name!, number: subject.number });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return undefined;
    throw error;
  }
  const repo = observed?.repository;
  if (!isRecord(repo) || String(repo.fullDatabaseId) !== client.source.repositoryId
    || typeof repo.nameWithOwner !== "string" || repo.nameWithOwner.toLowerCase() !== client.source.repository
    || !isRecord(repo.pullRequest) || repo.pullRequest.isInMergeQueue !== true
    || !isQueueParticipant(repo.pullRequest, subject)) return undefined;
  const entry = repo.pullRequest.mergeQueueEntry;
  if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 256
    || !isRecord(entry.baseCommit) || commitSha(entry.baseCommit.oid) !== baseCommit
    || !isRecord(entry.headCommit) || !isRecord(entry.pullRequest) || !isQueueParticipant(entry.pullRequest, subject)) return undefined;
  const testedCommit = commitSha(entry.headCommit.oid);
  if (!testedCommit || testedCommit === subject.headSha || testedCommit === baseCommit) return undefined;
  const testedTree = isRecord(entry.headCommit.tree) ? commitSha(entry.headCommit.tree.oid) : undefined;
  const proof = { queueEntryId: entry.id, baseCommit, testedCommit, ...(testedTree ? { testedTree } : {}) };
  return { ...proof, membershipProofRef: `github:merge-queue:${digest([subject.repositoryId, subject.number, subject.baseRef, subject.headSha, proof])}` };
}

function isQueueParticipant(pr: Record<string, unknown>, subject: LingAppServerGitHubSubject): boolean {
  return pr.number === subject.number && pr.headRefOid === subject.headSha && pr.baseRefName === subject.baseRef;
}

async function readDeliveryBase(client: GitHubReadClient, subject: LingAppServerGitHubSubject) {
  if (subject.merged && subject.mergeSha) {
    const commit = await readCommit(client, subject.mergeSha);
    const parents = commit?.parents;
    if (!parents?.[0]) throw new HttpError(502, "github_observation_invalid", "GitHub did not confirm the merged commit.");
    return { baseCommit: parents[0], mergedCommit: subject.mergeSha, mergedTree: commit?.tree,
      integrationCommit: parents.length === 2 && parents[1] === subject.headSha ? subject.mergeSha : undefined };
  }
  const escapedRef = subject.baseRef!.split("/").map(encodeURIComponent).join("/");
  const ref = await client.get(`/git/ref/heads/${escapedRef}`);
  const baseCommit = isRecord(ref.object) && ref.object.type === "commit" ? commitSha(ref.object.sha) : undefined;
  if (!baseCommit || ref.ref !== `refs/heads/${subject.baseRef}`) {
    throw new HttpError(502, "github_observation_invalid", "GitHub did not confirm the current base branch.");
  }
  const preview = subject.mergeSha && subject.state === "open" ? await readCommit(client, subject.mergeSha) : undefined;
  const parents = preview?.parents;
  return { baseCommit, mergedCommit: undefined, mergedTree: undefined,
    integrationCommit: parents?.length === 2 && parents[0] === baseCommit && parents[1] === subject.headSha ? subject.mergeSha : undefined };
}

async function readCommit(client: GitHubReadClient, oid: string) {
  let commit: Record<string, unknown>;
  try { commit = await client.get(`/git/commits/${oid}`); } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return undefined;
    throw error;
  }
  if (commit.sha !== oid || !Array.isArray(commit.parents)) return undefined;
  const parents = commit.parents.map(parent => isRecord(parent) ? commitSha(parent.sha) : undefined);
  const tree = isRecord(commit.tree) ? commitSha(commit.tree.sha) : undefined;
  return parents.every((parent): parent is string => parent !== undefined) ? { parents, tree } : undefined;
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
  const applicable = workflowRuns.filter(run => run.workflow_id === check.workflowId && run.head_sha === testedCommit
    && (check.basis !== "merge_group" || run.event === "merge_group"))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
  const run = applicable[0];
  if (!run) return { check, testedCommit, outcome: "pending", reason: "applicable_check_missing" };
  const runId = positiveId(run.id);
  const runAttempt = positiveId(run.run_attempt);
  if (!runId || !runAttempt || typeof run.created_at !== "string") return unavailable(check, "ambiguous_run");
  const proof = { check, testedCommit, runId, runAttempt };
  if (run.status !== "completed") return { ...proof, outcome: "pending", reason: "current_attempt_pending" };
  const applicableEvents = check.basis === "merge_group" ? ["merge_group"] : ["push", "pull_request", "workflow_dispatch"];
  if (typeof run.path !== "string" || run.path.split("@", 1)[0] !== check.workflowPath
    || !applicableEvents.includes(String(run.event))) {
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
