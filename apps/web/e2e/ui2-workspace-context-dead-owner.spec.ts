import { access, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const workspaceFeatureUrl = new URL("../src/features/workspace/", import.meta.url);
const workspaceStylesUrl = new URL("../src/styles/workspace.css", import.meta.url);

test("unreachable legacy Workspace Context owners stay deleted", async () => {
  await expectFileMissing(new URL("WorkspaceContextPanel.tsx", workspaceFeatureUrl));
  await expectFileMissing(new URL("workspace-context-presentation.ts", workspaceFeatureUrl));

  const [barrelSource, workspaceCss] = await Promise.all([
    readFile(new URL("index.ts", workspaceFeatureUrl), "utf8"),
    readFile(workspaceStylesUrl, "utf8"),
  ]);

  expect(barrelSource).not.toContain("WorkspaceContextPanel");
  expect(barrelSource).not.toContain("RuntimeStatePanel");
  expect(workspaceCss).not.toContain(".runtime-context-object-row");
  expect(workspaceCss).not.toContain(".runtime-list-row-copy");
});

async function expectFileMissing(url: URL): Promise<void> {
  await expect(access(url)).rejects.toMatchObject({ code: "ENOENT" });
}
