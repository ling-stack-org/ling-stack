const PROOF_JOB = "Analyze JavaScript/TypeScript";
const MAX_PROOF_AGE = 24 * 60 * 60 * 1000;

// Overmatch directory inputs (including dotfiles) rather than miss source changes.
export function isCodeqlInput(file) {
  return /^(?:\.github\/(?:actions|codeql|workflows)|apps|packages|scripts|patches)\//u.test(file)
    || /\.(?:[cm]?[jt]sx?|vue|svelte|html?)$/u.test(file)
    || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.gitattributes)$/u.test(file)
    || ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file);
}

async function compareInputs(github, repository, base, head) {
  const { data: diff } = await github.rest.repos.compareCommitsWithBasehead({
    ...repository, basehead: `${base}...${head}`,
  });
  // Comparisons cap files at 300; partial or divergent results are never proof.
  if (!["ahead", "identical"].includes(diff.status) || !Array.isArray(diff.files) || diff.files.length >= 300) {
    return { scan: true, reason: "input comparison is incomplete or divergent" };
  }
  const changed = diff.files.some((file) => isCodeqlInput(file.filename)
    || (file.previous_filename && isCodeqlInput(file.previous_filename)));
  return { scan: changed, reason: `${changed ? "changed" : "unchanged"} scan inputs` };
}

/** Only a recent, successful main scan can authorize skipping a scheduled scan. */
export async function selectCodeqlScan({ github, context, now = Date.now() }) {
  const scan = (reason) => ({ scan: true, reason });
  if (!["schedule", "pull_request"].includes(context.eventName)) return scan("manual runs always scan");
  const repository = context.repo;
  const fullName = `${repository.owner}/${repository.repo}`;
  try {
    if (context.eventName === "pull_request") {
      const pr = context.payload?.pull_request;
      if (!pr?.base?.sha || !pr?.head?.sha) return scan("PR comparison SHAs are unavailable");
      return await compareInputs(github, repository, pr.base.sha, pr.head.sha);
    }
    if (context.ref !== "refs/heads/main") return scan("not the main ref");
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repository, workflow_id: "codeql.yml", branch: "main", per_page: 30,
    });
    for (const run of data.workflow_runs) {
      if (run.id === context.runId || !["schedule", "workflow_dispatch"].includes(run.event)
        || run.head_branch !== "main" || run.head_repository?.full_name !== fullName) continue;
      if (run.status !== "completed" || run.conclusion !== "success") {
        return scan("latest main attempt did not succeed");
      }
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
        ...repository, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
      });
      const proof = jobs.find((job) => job.name === PROOF_JOB && job.head_sha === run.head_sha
        && job.status === "completed" && job.conclusion === "success");
      // A successful scope-only run must never advance the baseline or refresh its age.
      if (!proof) continue;
      const completedAt = Date.parse(proof.completed_at);
      if (!Number.isFinite(completedAt) || completedAt > now || now - completedAt >= MAX_PROOF_AGE) {
        return scan("daily query and runner refresh is due");
      }
      if (run.head_sha === context.sha) return { scan: false, reason: `unchanged SHA; scan passed in run ${run.id}` };
      const result = await compareInputs(github, repository, run.head_sha, context.sha);
      return { ...result, reason: `${result.reason} since successful scan ${run.id}` };
    }
    return scan("no recent completed main scan in the bounded history");
  } catch (error) {
    return scan(`proof lookup unavailable: ${error.message}`);
  }
}
