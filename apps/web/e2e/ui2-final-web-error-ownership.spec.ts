import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const appShellPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const ownerPaths = [
  "../src/app/use-app-navigation-controller.ts",
  "../src/app/use-control-plane-invalidation.ts",
  "../src/app/use-workspace-settings-controller.ts",
  "../src/domains/conversations/use-conversation-domain.ts",
  "../src/domains/external-work/use-external-work-domain.ts",
  "../src/domains/plugins/use-plugins-domain.ts",
  "../src/domains/runtime/use-runtime-domain.ts",
  "../src/domains/teammates/use-teammates-domain.ts",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const pageInspectorPath = fileURLToPath(new URL(
  "../src/features/inspector/PageInspector.tsx",
  import.meta.url,
));
const feedbackGuardPath = fileURLToPath(new URL(
  "../scripts/check-ui2-feedback.mjs",
  import.meta.url,
));

test("T13-P.9EF final Web owners remove the generic AppShell error contract", async () => {
  const [appShell, pageInspector, feedbackGuard, ...owners] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(pageInspectorPath, "utf8"),
    readFile(feedbackGuardPath, "utf8"),
    ...ownerPaths.map((path) => readFile(path, "utf8")),
  ]);

  expect(appShell).not.toContain("const [errorMessage, setErrorMessage]");
  expect(appShell).not.toContain("setErrorMessage");
  expect(appShell).not.toMatch(/\berrorMessage\s*=\s*\{errorMessage\}/u);
  expect(pageInspector).not.toContain("readonly errorMessage: string;");
  expect(pageInspector).not.toMatch(/\n\s*errorMessage,\n/u);

  for (const owner of owners) {
    expect(owner).not.toContain("setErrorMessage");
    expect(owner).not.toMatch(/readonly\s+setErrorMessage\s*:/u);
  }

  expect(readMapBody(feedbackGuard, "genericErrorWriterBudgets").trim()).toBe("");
  expect(readMapBody(feedbackGuard, "genericErrorCompatibilityBudgets").trim()).toBe("");
  expect(readMapBody(feedbackGuard, "genericErrorConsumerBudgets").trim()).toBe("");
});

function readMapBody(source: string, name: string): string {
  const startToken = `const ${name} = new Map([`;
  const start = source.indexOf(startToken);
  if (start < 0) throw new Error(`Missing ${name}`);
  const bodyStart = start + startToken.length;
  const end = source.indexOf("\n]);", bodyStart);
  if (end < 0) throw new Error(`Missing ${name} boundary`);
  return source.slice(bodyStart, end);
}
