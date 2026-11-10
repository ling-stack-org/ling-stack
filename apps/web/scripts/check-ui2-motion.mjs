import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const migratedFiles = [
  "src/styles/base.css",
  "src/styles/app/sidebar-layout.css",
  "src/styles/app/sidebar-ui2.css",
  "src/styles/channel-execution-proposal.css",
  "src/styles/channel-right-dock/shell.css",
  "src/styles/conversation-toolbar.css",
  "src/styles/conversation-panels.css",
  "src/styles/creation-dialogs.css",
  "src/styles/features/media-production/canvas.css",
  "src/styles/features/media-production/dock.css",
  "src/styles/layout.css",
  "src/styles/settings-permissions.css",
  "src/styles/shared/conversation-terminal-report.css",
  "src/styles/shared/conversation-summary.css",
  "src/styles/shared/conversation-work-cell-activity.css",
  "src/styles/shared/conversation-work-cell-shell-artifacts.css",
  "src/styles/teammate-management-mcp.css",
  "src/styles/teammate-private-header.css",
];
const durationLiteral = /(?:^|[\s,(])(?:\d+(?:\.\d+)?ms|\d*\.\d+s)(?=$|[\s,;)])/u;
const rawEasing = /(?:^|[\s,(])(?:ease|ease-in|ease-out|ease-in-out|linear)(?=$|[\s,;)])/u;
const violations = [];


for (const sourcePath of migratedFiles) {
  const source = readFileSync(resolve(process.cwd(), sourcePath), "utf8");
  const declarations = source.matchAll(/transition(?:-duration|-delay)?\s*:\s*([^;]+);/gu);
  for (const declaration of declarations) {
    const value = declaration[1];
    if (/\ball\b/u.test(value) || durationLiteral.test(value) || rawEasing.test(value)) {
      const line = source.slice(0, declaration.index).split("\n").length;
      violations.push(`${sourcePath}:${line} transition: ${value.trim()}`);
    }
  }
}

const settleInAnimationFiles = [
  "src/styles/shared/conversation-artifact-preview.css",
  "src/styles/shared/conversation-work-cell-activity.css",
  "src/styles/shared/conversation-work-cell-shell-artifacts.css",
];

function listCssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listCssFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".css") ? [entryPath] : [];
  });
}

for (const sourcePath of settleInAnimationFiles) {
  const source = readFileSync(resolve(process.cwd(), sourcePath), "utf8");
  const declarations = source.matchAll(/animation\s*:\s*([^;]+);/gu);
  for (const declaration of declarations) {
    const value = declaration[1];
    if (
      value.includes("conversation-settle-in")
      && (durationLiteral.test(value) || rawEasing.test(value))
    ) {
      const line = source.slice(0, declaration.index).split("\n").length;
      violations.push(`${sourcePath}:${line} animation: ${value.trim()}`);
    }
  }
}

for (const absolutePath of listCssFiles(resolve(process.cwd(), "src/styles"))) {
  const source = readFileSync(absolutePath, "utf8");
  const sourcePath = absolutePath.slice(process.cwd().length + 1);
  const declarations = source.matchAll(/animation\s*:\s*([^;]+);/gu);
  for (const declaration of declarations) {
    const value = declaration[1].trim();
    if (
      value === "none"
      || value.includes("infinite")
      || (!durationLiteral.test(value) && !rawEasing.test(value))
    ) {
      continue;
    }
    const line = source.slice(0, declaration.index).split("\n").length;
    violations.push(`${sourcePath}:${line} finite animation: ${value}`);
  }
}

const removedLegacyMotionContracts = [
  ["src/styles/channel-right-dock/review-details.css", "channel-right-dock-shimmer"],
  ["src/styles/conversation-panels.css", ".spin-icon"],
];
for (const [sourcePath, legacyToken] of removedLegacyMotionContracts) {
  const source = readFileSync(resolve(process.cwd(), sourcePath), "utf8");
  if (source.includes(legacyToken)) {
    violations.push(`${sourcePath}: legacy motion token remains: ${legacyToken}`);
  }
}

const locatePulseSource = readFileSync(
  resolve(process.cwd(), "src/styles/shared/conversation-work-cell-activity.css"),
  "utf8",
);
if (!locatePulseSource.includes("conversation-locate-pulse var(--ling-motion-attention) var(--ling-ease-standard) 1")) {
  violations.push("conversation locate pulse must use the shared attention duration and easing tokens");
}

if (violations.length > 0) {
  console.error("Use Ling motion duration/easing tokens in migrated CSS owners:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(
  `UI 2.0 motion token contract: ${migratedFiles.length} transition owners + ${settleInAnimationFiles.length} settle-in owners + finite animation audit`,
);
