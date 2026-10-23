import { createHash } from "node:crypto";
import type { SecretResolver } from "@ling-stack/core";
import type { WorkSummaryPullRequest, WorkSummaryPullRequestBinding } from "@ling-stack/contracts";
import { SummaryCache } from "./cache.js";

export function parseSummaryPullRequest(value: string): { url: string; owner: string; repo: string; number: number } {
  const url = new URL(value);
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !match
    || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === ".." || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error("Enter a GitHub pull request URL: https://github.com/owner/repo/pull/123");
  }
  const owner = match[1]!.toLowerCase(), repo = match[2]!.toLowerCase();
  return { owner, repo, number: Number(match[3]), url: `https://github.com/${owner}/${repo}/pull/${Number(match[3])}` };
}

const cache = new SummaryCache<Omit<WorkSummaryPullRequest, "createdAt">>(30_000);
export async function readSummaryPullRequest(binding: WorkSummaryPullRequestBinding, secrets: SecretResolver): Promise<WorkSummaryPullRequest> {
  const parsed = parseSummaryPullRequest(binding.url);
  const base = { url: parsed.url, repository: `${parsed.owner}/${parsed.repo}`, number: parsed.number, state: "unknown", ci: "unknown" } as const;
  const token = secrets.resolve("env:GITHUB_TOKEN", "github_token").value || secrets.resolve("env:GH_TOKEN", "github_token").value;
  if (!token) return { ...binding, ...base, connection: "unconnected" };
  const key = `${parsed.url}:${createHash("sha256").update(token).digest("hex")}`;
  try {
    const value = await cache.get(key, async () => {
      const pull = await github(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`, token);
      const headSha = typeof pull.head?.sha === "string" && /^[a-f0-9]{40,64}$/.test(pull.head.sha) ? pull.head.sha : undefined;
      let ci: WorkSummaryPullRequest["ci"] = "unknown";
      if (headSha) {
        const [statuses, checks] = await Promise.allSettled([
          github(`/repos/${parsed.owner}/${parsed.repo}/commits/${headSha}/status`, token),
          github(`/repos/${parsed.owner}/${parsed.repo}/commits/${headSha}/check-runs?per_page=100`, token),
        ]);
        ci = summarizePullRequestCi(headSha, statuses.status === "fulfilled" ? statuses.value : undefined,
          checks.status === "fulfilled" ? checks.value : undefined);
      }
      return { ...base, title: typeof pull.title === "string" ? pull.title : undefined, headSha, ci,
        state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open",
        connection: "connected", checkedAt: new Date().toISOString() } satisfies Omit<WorkSummaryPullRequest, "createdAt">;
    });
    return { ...binding, ...value };
  } catch {
    return { ...binding, ...base, connection: "error", error: "GitHub status unavailable", checkedAt: new Date().toISOString() };
  }
}

// GitHub data remains untrusted at this boundary; only fields used by the projection are read.
type GithubRecord = Record<string, any>;
async function github(path: string, token: string): Promise<GithubRecord> {
  const response = await fetch(`https://api.github.com${path}`, { redirect: "error", signal: AbortSignal.timeout(8000), headers: {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return await response.json() as GithubRecord;
}

export function summarizePullRequestCi(sha: string, statuses?: GithubRecord, checks?: GithubRecord): WorkSummaryPullRequest["ci"] {
  const validStatuses = statuses?.sha === sha;
  const runs = Array.isArray(checks?.check_runs) ? checks.check_runs.filter((run: GithubRecord) => run.head_sha === sha) : [];
  if ((validStatuses && ["failure", "error"].includes(statuses.state))
    || runs.some((run: GithubRecord) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(run.conclusion))) return "failure";
  if ((validStatuses && statuses.total_count > 0 && statuses.state === "pending")
    || runs.some((run: GithubRecord) => run.status !== "completed")) return "pending";
  if (!validStatuses || !checks || checks.total_count > runs.length) return "unknown";
  if ((statuses.total_count > 0 || runs.length > 0) && (statuses.total_count === 0 || statuses.state === "success")
    && runs.every((run: GithubRecord) => ["success", "neutral", "skipped"].includes(run.conclusion))) return "success";
  return "unknown";
}
