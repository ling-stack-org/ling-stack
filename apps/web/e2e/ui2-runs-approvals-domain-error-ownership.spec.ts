import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const runsDomainPath = fileURLToPath(new URL(
  "../src/domains/runs/use-runs-domain.ts",
  import.meta.url,
));
const approvalsDomainPath = fileURLToPath(new URL(
  "../src/domains/approvals/use-approvals-domain.ts",
  import.meta.url,
));
const runControlPath = fileURLToPath(new URL(
  "../src/lib/use-run-control.ts",
  import.meta.url,
));

test("Runs owns load, stream, and mutation errors without the generic shell writer", async () => {
  const [runsDomain, runControl] = await Promise.all([
    readFile(runsDomainPath, "utf8"),
    readFile(runControlPath, "utf8"),
  ]);

  expect(runsDomain).not.toContain("setErrorMessage");
  expect(runControl).not.toContain("setErrorMessage");
  expect(runsDomain).toContain('setError({ scope: "load", message });');
  expect(runsDomain).toContain('setError({ scope: "stream", message });');
  expect(runsDomain).toContain('reportError: (message) => setError({ scope: "mutation", message })');
  expect(runControl).toContain("options.clearError();");
  expect(runControl).toMatch(/(?:options|optionsRef\.current)\.reportError\(/u);
});

test("Approvals separates list DomainError from approval and external-action owners", async () => {
  const approvalsDomain = await readFile(approvalsDomainPath, "utf8");

  expect(approvalsDomain).not.toContain("setErrorMessage");
  expect(approvalsDomain).toContain('setError({ scope: "load", message });');
  expect(approvalsDomain).not.toContain('setError({ scope: "mutation"');
  expect(approvalsDomain).toContain("readonly approvalErrors: Readonly<Record<string, string>>;");
  expect(approvalsDomain).toContain("setApprovalErrors((current) => ({ ...current, [approvalId]: message }));");
  expect(approvalsDomain).toContain("setExternalActionFailure(actionId, \"execute\", caught);");
  expect(approvalsDomain).toContain("setExternalActionFailure(actionId, \"cancel\", caught);");
  expect(approvalsDomain).toContain("isCurrentExternalRequest(`approval:${approvalId}`");
});
