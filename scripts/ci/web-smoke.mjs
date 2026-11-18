import { spawnSync } from "node:child_process";
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
  return file.replace(/[.]/gu, "\\.") + "$";
}

/** @param {ReturnType<typeof planWebSmoke>} plan @param {boolean} [listOnly] */
export function runWebSmoke(plan, listOnly = false) {
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
  const groups = [
    { name: "qa", files: qa, preview: true, extra: ["--grep", qaCases] },
    { name: "smoke", files: smoke, preview: true, extra: [] },
    { name: "changed", files: changed, preview: false, extra: [] },
  ];
  for (const { name, files, preview, extra } of groups) {
    if (files.length === 0) continue;
    const baselineEvidence = preview && files.some(file => baseline.includes(file) || qaSpecs.includes(file));
    console.log("Web %s (%s): %s", name, preview ? "production" : "dev", files.join(", "));
    const result = spawnSync("corepack", ["pnpm", "exec", "playwright", "test", ...files.map(exactPattern),
      "--reporter=line", `--output=test-results/${name}`, ...extra, ...(listOnly ? ["--list"] : [])], {
      cwd: web, stdio: "inherit",
      env: { ...process.env, LING_PLAYWRIGHT_PREVIEW: preview ? "1" : "0", LING_PLAYWRIGHT_REUSE_SERVER: "0",
        LING_CAPTURE_UI2_EVIDENCE: baselineEvidence ? "1" : "0" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runWebSmoke(JSON.parse(process.env.WEB_SMOKE_PLAN ?? "null"), process.argv[2] === "--list");
}
