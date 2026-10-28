// Poll CI status for the open PRs until all required checks complete.
const TOKEN = process.env.GH_TOKEN;
const PRS = [602, 605, 606];
const PR_NAMES = { 602: "provider catalog", 605: "shared skills", 606: "deliverables" };
const proxy = "http://127.0.0.1:7897";
const { execFileSync } = await import("node:child_process");

async function api(path) {
  const url = `https://api.github.com/repos/ling-stack-org/ling-stack/${path}`;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const stdout = execFileSync("curl", ["-s", "-m", "30", "-x", proxy, "-H", `Authorization: Bearer ${TOKEN}`, "-H", "Accept: application/vnd.github+json", url], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
      if (stdout.length === 0) throw new Error("empty");
      const parsed = JSON.parse(stdout);
      return parsed;
    } catch (error) {
      console.log(`  api retry ${attempt}: ${String(error).slice(0, 80)}`);
      await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
    }
  }
  throw new Error(`api failed: ${path}`);
}

for (let round = 1; round <= 12; round += 1) {
  console.log(`--- round ${round} ---`);
  let allDone = true;
  for (const number of PRS) {
    const pr = await api(`pulls/${number}`);
    const checks = await api(`commits/${pr.head.sha}/check-runs?per_page=100`);
    const runs = checks.check_runs ?? [];
    const pending = runs.filter((run) => run.status !== "completed").map((run) => run.name);
    const failed = runs.filter((run) => run.status === "completed" && run.conclusion !== "success").map((run) => `${run.name}:${run.conclusion}`);
    console.log(`#${number} (${PR_NAMES[number]}): runs=${runs.length} pending=[${pending.join(",") || "-"}] failed=[${failed.join(",") || "-"}]`);
    if (pending.length > 0) allDone = false;
    if (failed.length > 0) allDone = "failed";
  }
  if (allDone === true) {
    console.log("ALL GREEN");
    process.exit(0);
  }
  if (allDone === "failed") {
    console.log("FAILURES PRESENT");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
console.log("TIMEOUT");
process.exit(2);
