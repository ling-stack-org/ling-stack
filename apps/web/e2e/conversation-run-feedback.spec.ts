import { expect, test, type Page } from "@playwright/test";
import type { RunEventEnvelope } from "@ling-stack/contracts";

const feedbackSelector = '[data-conversation-diagnostic-code="run_feedback"]';
const diagnostic = { schemaVersion: 1, category: "rate_limited", basis: "structured_http_status", httpStatus: 429 } as const;
type FeedbackSurface = "normal" | "channel_root" | "branch" | "topic";

for (const surface of ["normal", "channel_root", "branch", "topic"] as const) {
  test(`${surface}: automatic retries update one row and a terminal model error replaces thinking`, async ({ page }, testInfo) => {
    const runId = `feedback-run-${surface}`;
    const events = [retryEvent(runId, 1)];
    const requestedRuns = await openFeedbackFixture(page, surface, events);
    const feedback = page.locator(feedbackSelector);
    const composer = surface === "topic" ? page.getByRole("textbox") : undefined;
    const originalComposer = await composer?.elementHandle();
    await composer?.fill("Continue using the existing composer.");
    await expect(feedback).toHaveCount(1);
    await expect(feedback).toContainText("Retrying automatically...");
    await expect(feedback).toContainText("Retry 1 of 3");
    const id = await feedback.getAttribute("data-conversation-timeline-id");

    events.push(retryEvent(runId, 2));
    await expect(feedback).toContainText("Retry 2 of 3");
    await expect(feedback).toHaveCount(1);
    await expect(feedback).toHaveAttribute("data-conversation-timeline-id", id!);
    await expect(page.locator(".conversation-thinking-indicator")).toHaveCount(0);

    // The durable terminal event arrives before the message/run polling snapshot.
    events.push({
      id: `${runId}:failed`, runId, seq: 3, ts: "2026-11-04T01:00:03.000Z", type: "run_error",
      data: { message: "private provider body must not be rendered", errorDiagnostic: diagnostic },
    });
    await expect(feedback).toContainText("Model response failed");
    await expect(feedback).toHaveAttribute("data-conversation-timeline-status", "failed");
    await expect(feedback).toHaveAttribute("data-conversation-timeline-id", id!);
    await expect(page.locator(".conversation-thinking-indicator")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("private provider body");
    await expect(feedback.getByRole("button", { name: /Retry response|Send|Configure model/u })).toHaveCount(0);
    if (composer) {
      expect(await composer.evaluate((element, original) => element === original, originalComposer!)).toBe(true);
      await expect(composer).toHaveValue("Continue using the existing composer.");
    }
    expect([...new Set(requestedRuns)]).toEqual([runId]);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-model-failure.png`) });
  });
}

test("native retries have no invented counter and clear when real response activity resumes", async ({ page }) => {
  const runId = "feedback-run-normal";
  const events: RunEventEnvelope[] = [{
    id: `${runId}:native-retry`, runId, seq: 1, ts: "2026-11-04T01:00:01.000Z", type: "progress",
    data: { nativeKind: "error", retrying: true },
  }];
  await openFeedbackFixture(page, "normal", events);
  const feedback = page.locator(feedbackSelector);
  await expect(feedback).toHaveCount(1);
  await expect(feedback).toContainText("Retrying automatically...");
  await expect(feedback).not.toContainText(/\d/u);

  events.push({
    id: `${runId}:resumed`, runId, seq: 2, ts: "2026-11-04T01:00:02.000Z", type: "assistant_text_delta",
    data: { text: "The model connection has recovered." },
  });
  await expect(feedback).toHaveCount(0);
});

function retryEvent(runId: string, retryAttempt: number): RunEventEnvelope {
  return {
    id: `${runId}:retry:${retryAttempt}`, runId, seq: retryAttempt,
    ts: `2026-11-04T01:00:0${retryAttempt}.000Z`, type: "provider_retry",
    data: { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "scheduled",
      retryAttempt, maxRetryAttempts: 3, delayMs: 1_000, errorDiagnostic: diagnostic },
  };
}

async function openFeedbackFixture(page: Page, surface: FeedbackSurface, events: RunEventEnvelope[]): Promise<string[]> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const requestedRuns: string[] = [];
  await page.route(/\/runs\/[^/]+\/events(?:\?|$)/u, async route => {
    const runId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    requestedRuns.push(runId);
    await route.fulfill({ json: { runId, events, nextSeq: events.at(-1)?.seq ?? 0 } });
  });
  await page.goto("/e2e/support/conversation-run-feedback.html");
  await page.evaluate(async selectedSurface => {
    const path = "/e2e/support/conversation-run-feedback-harness.tsx";
    const fixture: { mountRunFeedbackFixture: (surface: string) => unknown } = await import(/* @vite-ignore */ path);
    fixture.mountRunFeedbackFixture(selectedSurface);
  }, surface);
  return requestedRuns;
}
