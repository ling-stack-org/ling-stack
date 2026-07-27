import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";

const webRoot = process.cwd();
const sourceRoot = resolve(webRoot, "src");
const repoRoot = resolve(webRoot, "../..");

const legacyFeedbackBudgets = new Map([
  ["inline-success", 0],
  ["teammate-mcp-save-status", 0],
  ["cua-install-copy-status", 0],
]);

const feedbackTimerBudgets = new Map([
  ["apps/web/src/features/workspace/useChannelComposerDraftController.ts", 0],
  ["apps/web/src/features/mcp/McpToolsPage.tsx", 0],
  ["apps/web/src/features/providers/ProviderSettings.tsx", 0],
  ["apps/web/src/shared/conversation/view-store/use-conversation-action-view.ts", 1],
]);

const genericErrorWriterBudgets = new Map([
  ["apps/web/src/app/AppShell.tsx", 14],
  ["apps/web/src/app/use-app-navigation-controller.ts", 3],
  ["apps/web/src/app/use-control-plane-invalidation.ts", 2],
  ["apps/web/src/app/use-workspace-settings-controller.ts", 3],
  ["apps/web/src/domains/external-work/use-external-work-domain.ts", 13],
  ["apps/web/src/domains/runtime/use-runtime-domain.ts", 3],
]);

const genericErrorCompatibilityBudgets = new Map([
  ["apps/web/src/app/use-app-navigation-controller.ts", 1],
  ["apps/web/src/app/use-control-plane-invalidation.ts", 1],
  ["apps/web/src/app/use-workspace-settings-controller.ts", 1],
  ["apps/web/src/domains/external-work/use-external-work-domain.ts", 1],
  ["apps/web/src/domains/runtime/use-runtime-domain.ts", 1],
]);

const genericErrorConsumerBudgets = new Map([
  ["apps/web/src/app/AppShell.tsx", 1],
]);

const releasedGenericErrorContracts = [
  "apps/web/src/domains/automations/use-automations-domain.ts",
  "apps/web/src/domains/approvals/use-approvals-domain.ts",
  "apps/web/src/domains/mcp/use-mcp-domain.ts",
  "apps/web/src/domains/media/use-media-domain.ts",
  "apps/web/src/domains/providers/use-providers-domain.ts",
  "apps/web/src/domains/plugins/use-plugins-domain.ts",
  "apps/web/src/domains/runs/use-runs-domain.ts",
  "apps/web/src/domains/settings/use-settings-domain.ts",
  "apps/web/src/domains/work-items/use-durable-work-items-domain.ts",
  "apps/web/src/app/channel-sidebar-archive-actions.ts",
  "apps/web/src/app/use-channel-actions-controller.ts",
  "apps/web/src/app/use-channel-workflow-controller.ts",
  "apps/web/src/app/use-task-run-controller.ts",
  "apps/web/src/domains/workspace/use-workspace-domain.ts",
  "apps/web/src/domains/conversations/use-conversation-domain.ts",
  "apps/web/src/domains/teammates/use-teammates-domain.ts",
];

const sourceFiles = collectFiles(sourceRoot, new Set([".css", ".ts", ".tsx"]));
const sources = new Map(sourceFiles.map((file) => [relative(repoRoot, file), readFileSync(file, "utf8")]));
const violations = [];

for (const [token, budget] of legacyFeedbackBudgets) {
  const owners = [];
  for (const [file, source] of sources) {
    const count = countOccurrences(source, token);
    if (count > 0) owners.push({ count, file });
  }
  const total = owners.reduce((sum, owner) => sum + owner.count, 0);
  if (total > budget) {
    violations.push(`${token} grew from ${budget} to ${total}: ${owners.map((owner) => `${owner.file}(${owner.count})`).join(", ")}`);
  }
}

for (const [file, budget] of feedbackTimerBudgets) {
  const source = sources.get(file);
  if (source === undefined) {
    violations.push(`${file} feedback timer budget owner is missing`);
    continue;
  }
  const count = countMatches(source, /(?:globalThis\.|window\.)?setTimeout\s*\(/gu);
  if (count > budget) violations.push(`${file} feedback timer budget grew from ${budget} to ${count}`);
}

for (const [file, budget] of genericErrorWriterBudgets) {
  const source = sources.get(file);
  if (source === undefined) {
    violations.push(`${file} generic error writer budget owner is missing`);
    continue;
  }
  const count = countOccurrences(source, "setErrorMessage");
  if (count > budget) violations.push(`${file} generic error writer budget grew from ${budget} to ${count}`);
}

const registeredGenericWriterOwners = new Set([
  ...genericErrorWriterBudgets.keys(),
  ...releasedGenericErrorContracts,
]);
for (const [file, source] of sources) {
  if (!file.startsWith("apps/web/src/app/") && !file.startsWith("apps/web/src/domains/")) continue;
  const count = countOccurrences(source, "setErrorMessage");
  if (count > 0 && !registeredGenericWriterOwners.has(file)) {
    violations.push(`${file} introduced ${count} unregistered generic error writer reference(s)`);
  }
}

for (const [file, budget] of genericErrorCompatibilityBudgets) {
  const source = sources.get(file);
  if (source === undefined) {
    violations.push(`${file} generic error compatibility owner is missing`);
    continue;
  }
  const count = countMatches(source, /readonly\s+setErrorMessage\s*:/gu);
  if (count > budget) violations.push(`${file} generic error compatibility prop grew from ${budget} to ${count}`);
}

for (const [file, source] of sources) {
  if (!file.startsWith("apps/web/src/app/") && !file.startsWith("apps/web/src/domains/")) continue;
  const count = countMatches(source, /readonly\s+setErrorMessage\s*:/gu);
  if (count > 0 && !genericErrorCompatibilityBudgets.has(file)) {
    violations.push(`${file} introduced ${count} unregistered generic error compatibility prop(s)`);
  }
}

for (const [file, budget] of genericErrorConsumerBudgets) {
  const source = sources.get(file);
  if (source === undefined) {
    violations.push(`${file} generic error consumer owner is missing`);
    continue;
  }
  const count = countMatches(source, /\berrorMessage\s*=\s*\{errorMessage\}/gu);
  if (count > budget) violations.push(`${file} generic error consumer grew from ${budget} to ${count}`);
}

for (const file of releasedGenericErrorContracts) {
  const source = sources.get(file);
  if (source === undefined) {
    violations.push(`${file} released generic error contract owner is missing`);
    continue;
  }
  const count = countOccurrences(source, "setErrorMessage");
  if (count > 0) violations.push(`${file} restored ${count} released generic error contract reference(s)`);
}

for (const [file, source] of sources) {
  if (!file.startsWith("apps/web/src/features/") && !file.startsWith("apps/web/src/app/")) continue;
  if (/\bToastProvider\b|\bToastViewport\b/gu.test(source)) {
    violations.push(`${file} creates or imports a Feature-local Toast provider/viewport`);
  }
}

if (violations.length > 0) {
  console.error("UI 2.0 feedback ownership contract failed:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`UI 2.0 feedback legacy budget: ${[...legacyFeedbackBudgets].map(([token, budget]) => `${token}<=${budget}`).join(", ")}`);
console.log(`UI 2.0 feedback timer owners: ${[...feedbackTimerBudgets].map(([file, budget]) => `${file.replace("apps/web/src/", "")}<=${budget}`).join(", ")}`);
console.log(`UI 2.0 generic error writer budget: ${[...genericErrorWriterBudgets.values()].reduce((sum, budget) => sum + budget, 0)} across ${genericErrorWriterBudgets.size} owners; released contracts=${releasedGenericErrorContracts.length}`);
console.log(`UI 2.0 generic error compatibility prop budget: ${[...genericErrorCompatibilityBudgets.values()].reduce((sum, budget) => sum + budget, 0)} across ${genericErrorCompatibilityBudgets.size} owners`);
console.log(`UI 2.0 generic error consumer budget: ${[...genericErrorConsumerBudgets.values()].reduce((sum, budget) => sum + budget, 0)} across ${genericErrorConsumerBudgets.size} owners`);
console.log("UI 2.0 Feature-local Toast provider/viewport: 0");

function collectFiles(root, extensions) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(file, extensions));
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(file);
  }
  return files;
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function countOccurrences(source, value) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}
