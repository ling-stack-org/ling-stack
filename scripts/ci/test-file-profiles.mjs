import { spawnSync } from "node:child_process";

export const daemonBabelParser = "@babel/parser";
export const daemonBabelParserProfile = "daemon-babel-parser";
export const daemonBabelParserTestFiles = [
  "test/codex-protocol-integrity.test.mjs",
  "test/workflow-scheduler-wiring.test.mjs",
];

/** The focused profile covers every checked-in Daemon test that uses the parser. */
export function hasDaemonBabelParserCoverage(root) {
  const directory = "packages/daemon";
  const expected = new Set([
    "package.json",
    "scripts/import-codex-protocol.mjs",
    ...daemonBabelParserTestFiles,
  ].map(file => `${directory}/${file}`));
  const matches = spawnSync("git", ["grep", "-z", "-l", "-F", "-e", daemonBabelParser, "--", directory], {
    cwd: root, encoding: "utf8",
  });
  if (matches.status !== 0) return false;
  const files = matches.stdout.split("\0").filter(Boolean);
  return files.length === expected.size && files.every(file => expected.has(file));
}

export const terminalReportTestFiles = [
  "test/terminal-report-idempotency.test.ts",
  "test/terminal-report-migration.test.ts",
  "test/terminal-report-privacy.test.ts",
  "test/terminal-report-store.test.ts",
  "test/terminal-report.test.ts",
];

const terminalReportChangedPaths = new Set([
  "packages/core/test/terminal-report-fixture.d.mts",
  "packages/core/test/terminal-report-idempotency.test.ts",
  "packages/core/test/terminal-report-migration.test.ts",
  "packages/core/test/terminal-report-privacy.test.ts",
  "packages/core/test/terminal-report-store.test.ts",
  "packages/core/test/terminal-report.test.ts",
  "packages/core/test/terminal-report-idempotency.test.mjs",
  "packages/core/test/terminal-report-migration.test.mjs",
  "packages/core/test/terminal-report-privacy.test.mjs",
  "packages/core/test/terminal-report-store.test.mjs",
  "packages/core/test/terminal-report.test.mjs",
]);

export function matchesTerminalReportProfile(files) {
  return files.includes("packages/core/test/terminal-report-fixture.d.mts")
    && files.includes("packages/core/test/terminal-report.test.ts")
    && files.every(file => terminalReportChangedPaths.has(file));
}
