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
