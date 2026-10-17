import type { Page } from "@playwright/test";

/** For fixtures that intercept POST before mock admission, no accepted receipt exists. */
export async function mockUnknownSubmissionReceipt(page: Page): Promise<void> {
  await page.route(/\/conversation-submissions(?:\?.*)?$/u, async route => {
    const query = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: { cwd: query.get("cwd"), idempotencyKey: query.get("idempotencyKey"), status: "unknown" } });
  });
}
