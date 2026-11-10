import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, isRecord } from "./support/mock-state";

// Regression: E6-CHANNEL-BOOT — desktop startup discarded the old observation
// without a fresh committed-owner read. API fixture, not packaged macOS evidence.
// Found by /qa on 2026-10-28
// Report: output/e6-20260928/channel-policy-cold-start-empty-channels-root-cause-20261028.md
test("desktop cold start and reload hydrate existing channels without navigation or focus", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", "/tmp/stale-browser-workspace");
    Object.defineProperty(window, "lingDesktop", { configurable: true, value: {
      platform: "macos", daemonBaseUrl: "http://127.0.0.1:17891",
      daemon: { onStatusChanged(listener: (status: unknown) => void) {
        listener({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true });
        return () => {};
      } },
    } });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const engineering = state.channels.find(channel => isRecord(channel) && channel.name === "Engineering");
  expect(isRecord(engineering)).toBe(true);
  state.channels.push({ ...engineering as Record<string, unknown>, id: "channel_boot_existing", name: "Existing Bootstrap Channel" });
  const initialRuns = state.runs.length, mutations: string[] = [], pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && ["/channels", "/runs", "/conversations/turns"].includes(new URL(request.url()).pathname)) {
      mutations.push(request.url());
    }
  });
  await mockDaemon(page, state, { defaultWorkspaceCwd: cwd });
  let healthReads = 0;
  let releaseLateHealth!: () => void;
  let lateHealthReady = new Promise<void>(resolve => { releaseLateHealth = resolve; });
  let markLateHealthReturned!: () => void;
  let lateHealthReturned = new Promise<void>(resolve => { markLateHealthReturned = resolve; });
  await page.route(url => url.origin === "http://127.0.0.1:17891" && url.pathname === "/health", async route => {
    const index = ++healthReads;
    if (index === 2) await lateHealthReady;
    await route.fallback();
    if (index === 2) markLateHealthReturned();
  });
  let release!: () => void;
  let ready = new Promise<void>(resolve => { release = resolve; });
  const reads: string[] = [];
  await page.route(url => url.origin === "http://127.0.0.1:17891" && url.pathname === "/channels", async route => {
    reads.push(new URL(route.request().url()).searchParams.get("cwd") ?? "");
    await ready;
    await route.fallback();
  });
  for (const phase of ["cold-start", "reload"]) {
    if (phase === "cold-start") await page.goto("/");
    else {
      ready = new Promise<void>(resolve => { release = resolve; });
      healthReads = 0;
      lateHealthReady = new Promise<void>(resolve => { releaseLateHealth = resolve; });
      lateHealthReturned = new Promise<void>(resolve => { markLateHealthReturned = resolve; });
      await page.reload();
    }
    await expect.poll(() => healthReads).toBe(2);
    expect(pageErrors).toEqual([]);
    await expect.poll(() => reads.length).toBe(phase === "cold-start" ? 1 : 2);
    expect(reads.at(-1)).toBe(cwd, "real committed-owner request, not preinitialized mock settings");
    release();
    await expect(page.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Existing Bootstrap Channel", exact: true })).toBeVisible();
    // StrictMode's second startup effect completes only after hydration. Let
    // fetch continuations and React's paint run, not an arbitrary sleep.
    releaseLateHealth();
    await lateHealthReturned;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Existing Bootstrap Channel", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${phase}-existing-channels.png`) });
  }
  expect(reads).toEqual([cwd, cwd]);
  expect(mutations).toEqual([]);
  expect(state.runs).toHaveLength(initialRuns);
  expect(pageErrors).toEqual([]);
});
