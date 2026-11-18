import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const qaSpecs = [
  "e2e/ui2-shell-feedback-permission.spec.ts",
  "e2e/ui2-settings-skill-library.spec.ts",
  "e2e/ui2-teammate-management-skills.spec.ts",
  "e2e/ui2-council-members.spec.ts",
];
const qaCases = "without a configured model|full access confirmation|built-in skill timestamps|Chinese built-in skill|Chinese QA member";
const companions = "e2e/companions.spec.ts";
const summary = "e2e/conversation-change-summary.spec.ts";
const baseline = [companions, summary];
const localOnly = new Set(["e2e/dark-photo-visual-acceptance.spec.ts"]); // Requires a local photo and evidence directory.
const specPath = /^e2e\/(?:[\w-]+\/)*[\w.-]+\.spec\.ts$/u;
const domains = [
  [/^src\/(?:features\/companions\/|styles\/companion\.css$|api\/companions\.ts$)|^public\/companions\//u, [companions]],
  [/^src\/(?:shared\/conversation\/change-summary\/|styles\/shared\/conversation-change-summary\.css$|api\/workspace-changes\.ts$)/u, [summary]],
  [/^src\/(?:features\/media\/|styles\/features\/(?:media-jobs|media-production)\/)/u, ["e2e/media-jobs.spec.ts", "e2e/media-production.spec.ts"]],
  [/^src\/(?:features\/plugins\/|styles\/plugins\/)/u, ["e2e/plugins.spec.ts", "e2e/ui2-plugin-manager.spec.ts"]],
  [/^src\/styles\/theme-background\.css$/u, ["e2e/full-window-background.spec.ts", "e2e/theme-full-window-p0.spec.ts"]],
];

/** @param {string} file */
function exists(file) {
  return lstatSync(resolve(web, file), { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Shared or unclassified inputs retain all baseline specs. Changed specs
 * outside the production plan use Vite dev for their HTML harnesses.
 * @param {{files: string[], full?: boolean}} input
 */
export function planWebSmoke({ files, full = false }) {
  const smoke = new Set();
  const changed = new Set();
  const manual = new Set();
  let useBaseline = full || files.length === 0;
  for (const path of files) {
    const file = path.startsWith("apps/web/") ? path.slice("apps/web/".length) : "";
    if (specPath.test(file)) {
      if (!exists(file)) {
        useBaseline = true;
      } else if (localOnly.has(file)) {
        manual.add(file);
      } else {
        changed.add(file);
      }
      continue;
    }
    const domain = domains.find(([pattern]) => pattern.test(file));
    if (domain) {
      for (const spec of domain[1]) smoke.add(spec);
    } else {
      useBaseline = true;
    }
  }
  if (!useBaseline && smoke.size === 0 && changed.size === 0) useBaseline = true;
  for (const spec of baseline) if (useBaseline || changed.has(spec)) smoke.add(spec);
  const qa = useBaseline ? qaSpecs.filter(file => !changed.has(file)) : [];
  for (const file of qaSpecs) if (changed.has(file)) smoke.add(file);
  return { qa, smoke: [...smoke].sort(),
    changed: [...changed].filter(file => !smoke.has(file)).sort(), manual: [...manual].sort() };
}

/** @param {string} file */
function exactPattern(file) {
  const escapedPath = resolve(web, file).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return `^${escapedPath}$`;
}

/** @param {ReturnType<typeof planWebSmoke>} plan @param {boolean} [listOnly] */
export async function runWebSmoke(plan, listOnly = false) {
  const { qa, smoke, changed } = plan;
  const all = [...qa, ...smoke, ...changed];
  if (!all.length || new Set(all).size !== all.length || all.some(file => !specPath.test(file) || !exists(file))) {
    throw new Error("Web smoke plan must contain existing, distinct Web specs");
  }
  if (!listOnly) {
    const directory = resolve(web, "test-results");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "ci-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  }
  const production = [
    { name: "qa", files: qa, preview: true, extra: ["--grep", qaCases] },
    { name: "smoke", files: smoke, preview: true, extra: [] },
  ];
  const dev = [{ name: "changed", files: changed, preview: false, extra: ["--max-failures=1"] }];
  if (listOnly || changed.length === 0 || qa.length + smoke.length === 0) {
    return runGroups([...production, ...dev], listOnly);
  }
  const devPort = Number.parseInt(process.env.LING_PLAYWRIGHT_PORT ?? "4174", 10);
  const previewPort = String(devPort === 65535 ? devPort - 1 : devPort + 1);
  const results = await Promise.allSettled([runGroups(production, false, previewPort), runGroups(dev, false)]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    if (result.value !== 0) return result.value;
  }
  return 0;
}

/**
 * @param {{ name: string, files: string[], preview: boolean, extra: string[] }[]} groups
 * @param {boolean} listOnly
 * @param {string} [port]
 */
async function runGroups(groups, listOnly, port = process.env.LING_PLAYWRIGHT_PORT) {
  for (const { name, files, preview, extra } of groups) {
    if (files.length === 0) continue;
    const baselineEvidence = preview && files.some(file => baseline.includes(file) || qaSpecs.includes(file));
    console.log("Web %s (%s): %s", name, preview ? "production" : "dev", files.join(", "));
    const args = ["pnpm", "exec", "playwright", "test", ...files.map(exactPattern),
      "--reporter=line", `--output=test-results/${name}`, ...extra, ...(listOnly ? ["--list"] : [])];
    /** @type {Promise<number>} */
    const exit = new Promise((resolve, reject) => {
      const child = spawn("corepack", args, {
        cwd: web, stdio: "inherit",
        env: { ...process.env, LING_PLAYWRIGHT_PORT: port, LING_PLAYWRIGHT_PREVIEW: preview ? "1" : "0",
          LING_PLAYWRIGHT_REUSE_SERVER: "0", LING_CAPTURE_UI2_EVIDENCE: baselineEvidence ? "1" : "0" },
      });
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 1));
    });
    const status = await exit;
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runWebSmoke(JSON.parse(process.env.WEB_SMOKE_PLAN ?? "null"), process.argv[2] === "--list");
}
