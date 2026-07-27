import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const evidenceRoot = fileURLToPath(new URL(
  "../../../../docs/design/ui2.0升级/evidence/",
  import.meta.url,
));

export async function captureP6FeedbackEvidence(
  page: Page,
  directory: string,
  filename: string,
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  const outputDirectory = join(evidenceRoot, directory);
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: join(outputDirectory, filename),
  });
}
