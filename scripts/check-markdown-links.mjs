import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
  { cwd: repositoryRoot, encoding: "utf8" },
).split("\0").filter((file) => file && existsSync(resolve(repositoryRoot, file)));

const failures = [];

for (const file of files) {
  const source = readFileSync(resolve(repositoryRoot, file), "utf8");
  const targets = [
    ...markdownTargets(source),
    ...htmlTargets(source),
  ];

  for (const rawTarget of targets) {
    const target = localPath(rawTarget);
    if (!target) continue;

    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(target);
    } catch {
      failures.push(`${file}: invalid URL encoding in ${rawTarget}`);
      continue;
    }

    const absoluteTarget = decodedTarget.startsWith("/")
      ? resolve(repositoryRoot, `.${decodedTarget}`)
      : resolve(repositoryRoot, dirname(file), decodedTarget);
    if (!existsSync(absoluteTarget)) {
      failures.push(`${file}: missing ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Markdown link check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Checked ${files.length} Markdown files; all local link targets exist.`);

function markdownTargets(source) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    targets.push(stripAngles(match[1] ?? ""));
  }
  return targets;
}

function htmlTargets(source) {
  const targets = [];
  const pattern = /<(?:a|img)\b[^>]*\b(?:href|src)=["']([^"']+)["'][^>]*>/gi;
  for (const match of source.matchAll(pattern)) {
    targets.push(match[1] ?? "");
  }
  return targets;
}

function localPath(rawTarget) {
  const target = rawTarget.trim();
  if (!target || target.startsWith("#")) return undefined;
  if (/^(?:https?:|mailto:|data:|javascript:)/i.test(target)) return undefined;
  return target.split("#", 1)[0]?.split("?", 1)[0] || undefined;
}

function stripAngles(value) {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}
