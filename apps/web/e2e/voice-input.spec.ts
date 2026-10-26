import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidence = resolve("../../output/playwright/voice-input");

async function installFakeRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      lang = "";
      continuous = false;
      interimResults = false;
      started = false;
      constructor() {
        const existing = (window as unknown as { __fakeRecognitions?: FakeSpeechRecognition[] }).__fakeRecognitions ?? [];
        existing.push(this);
        (window as unknown as { __fakeRecognitions?: FakeSpeechRecognition[] }).__fakeRecognitions = existing;
      }
      start(): void { this.started = true; }
      stop(): void { this.onend?.(); }
      abort(): void { this.onend?.(); }
      emit(transcript: string, isFinal: boolean): void {
        this.onresult?.({
          resultIndex: 0,
          results: { length: 1, 0: { isFinal, 0: { transcript } } },
        });
      }
      fail(code: string): void { this.onerror?.({ error: code }); }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
  });
}

function fakeRecognitions(page: Page) {
  return page.evaluate(() => {
    const instances = (window as unknown as { __fakeRecognitions?: Array<{ started: boolean; emit(transcript: string, isFinal: boolean): void; fail(code: string): void; onend: (() => void) | null }> }).__fakeRecognitions ?? [];
    return instances;
  });
}

test("voice dictation appends transcript to the draft and never auto-sends", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFakeRecognition(page);
  const state = createBaseState();
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const composer = page.getByLabel("New conversation composer", { exact: true });
  await expect(composer).toBeVisible();
  const mic = page.getByRole("button", { name: "Dictate message", exact: true });
  await expect(mic).toBeVisible();
  await mic.click();

  const body = page.locator(".normal-conversation-composer-body");
  await expect(body).toHaveAttribute("data-dictating", "true");
  await expect(page.locator(".composer-dictating-badge")).toContainText("Dictating");

  const recognitions = await fakeRecognitions(page);
  expect(recognitions.length).toBe(1);
  await page.evaluate(() => {
    const instances = (window as unknown as { __fakeRecognitions?: Array<{ emit(transcript: string, isFinal: boolean): void }> }).__fakeRecognitions ?? [];
    instances[0].emit("hello from voice", true);
  });

  const input = composer.getByRole("textbox");
  await expect(input).toHaveAttribute("data-value", "hello from voice");

  // Dictation must not send by itself.
  await expect(page.locator(".normal-conversation-feed .message-row, .conversation-home-feed .message-row")).toHaveCount(0);

  await page.screenshot({ path: `${evidence}/dictating.png`, animations: "disabled" });

  await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
  await expect(body).not.toHaveAttribute("data-dictating");
  expect(errors).toEqual([]);
});

test("denied microphone access surfaces the recovery message", async ({ page }) => {
  await installFakeRecognition(page);
  const state = createBaseState();
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const mic = page.getByRole("button", { name: "Dictate message", exact: true });
  await mic.click();
  await page.evaluate(() => {
    const instances = (window as unknown as { __fakeRecognitions?: Array<{ fail(code: string): void }> }).__fakeRecognitions ?? [];
    instances[instances.length - 1].fail("not-allowed");
  });
  await expect(page.locator(".normal-conversation-composer-feedback")).toContainText("Microphone access was denied");
});
