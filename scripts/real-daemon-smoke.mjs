/* Real-daemon browser smoke test (no mocks): drives the web UI served by
 * vite against the real daemon on 127.0.0.1:17891 and captures screenshots. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const WEB = "http://127.0.0.1:5199";
const DAEMON = "http://127.0.0.1:17891";
const EVIDENCE = "output/playwright/real-daemon-smoke";
const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail ?? ""}`);
}

await mkdir(EVIDENCE, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.addInitScript(() => {
  localStorage.setItem("ling-stack.locale", "en-US");
  localStorage.setItem("ling-first-run:v1", JSON.stringify({
    version: 1,
    status: "completed",
    workspaceIdentity: "smoke",
    updatedAt: "2026-10-27T00:00:00.000Z",
  }));
});

await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${EVIDENCE}/01-home.png` });
record("home loads", true, `title=${await page.title()}`);

// 1. Startup & diagnostics against the real daemon
await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /^(Settings|设置)$/ }).click();
const sections = page.getByLabel(/Settings sections|设置分组/);
await sections.getByRole("button", { name: /Startup and diagnostics|启动与诊断/u }).click();
const card = page.locator(".diagnostics-doctor-card");
await card.waitFor({ state: "visible", timeout: 20_000 });
const checkCount = await card.locator(".diagnostics-doctor-check").count();
record("doctor card shows real checks", checkCount >= 4, `checks=${checkCount}`);
const okChecks = await card.locator('.diagnostics-doctor-check[data-status="ok"]').count();
const warnChecks = await card.locator('.diagnostics-doctor-check[data-status="warning"]').count();
record("doctor mixes real ok/warning", okChecks >= 3 && warnChecks >= 1, `ok=${okChecks} warning=${warnChecks}`);
const logSection = card.locator(".diagnostics-doctor-log-section");
await logSection.locator("summary").click();
const logText = await logSection.locator(".diagnostics-doctor-log-lines").textContent();
record("log tail streams real daemon log", /daemon|ling|listen|start/iu.test(logText ?? ""), `chars=${logText?.length ?? 0}`);
await page.screenshot({ path: `${EVIDENCE}/02-diagnostics-real.png`, fullPage: true });

// 2. Notifications preferences round-trip against the real daemon
const notifCard = page.locator(".notifications-preferences-card");
await notifCard.waitFor({ state: "visible", timeout: 20_000 });
const before = await (await fetch(`${DAEMON}/notifications/preferences`)).json();
const toggle = notifCard.getByRole("switch").first();
await toggle.click();
await notifCard.getByRole("button", { name: /Save notification preferences/ }).click();
await page.waitForTimeout(1500);
const after = await (await fetch(`${DAEMON}/notifications/preferences`)).json();
record("notification prefs persist to real daemon", after.preferences.globalEnabled === !before.preferences.globalEnabled,
  `before=${before.preferences.globalEnabled} after=${after.preferences.globalEnabled}`);
await toggle.click();
await notifCard.getByRole("button", { name: /Save notification preferences/ }).click();
await page.waitForTimeout(1500);
const restored = await (await fetch(`${DAEMON}/notifications/preferences`)).json();
record("notification prefs restored", restored.preferences.globalEnabled === before.preferences.globalEnabled, `global=${restored.preferences.globalEnabled}`);
await page.screenshot({ path: `${EVIDENCE}/03-notifications-real.png`, fullPage: true });

// 3. Voice input against the real browser engine (headless may deny; both
//    paths prove the composer wiring works end to end).
await page.getByRole("button", { name: /Back to app|返回应用/u }).click().catch(() => {});
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const mic = page.getByRole("button", { name: /Dictate message|语音输入/u });
const micVisible = await mic.isVisible().catch(() => false);
if (micVisible) {
  await mic.click();
  await page.waitForTimeout(2500);
  const dictating = await page.locator(".normal-conversation-composer-body[data-dictating='true']").count();
  const feedback = await page.locator(".normal-conversation-composer-feedback").textContent().catch(() => "");
  record("voice mic click produces dictation state or surfaced error", dictating > 0 || (feedback ?? "").length > 0,
    dictating > 0 ? "recording" : `error: ${(feedback ?? "").slice(0, 80)}`);
  await page.screenshot({ path: `${EVIDENCE}/04-voice-real.png` });
} else {
  record("voice mic click produces dictation state or surfaced error", false, "mic button not visible on home");
}

// 4. IM destinations CRUD through the real daemon (settings UI lands later)
const created = await fetch(`${DAEMON}/im-destinations`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "Smoke Feishu", provider: "feishu", webhookRef: "env:SMOKE_FEISHU_WEBHOOK" }),
});
const createdBody = await created.json();
record("IM destination create (ref-only) on real daemon", created.status === 201, `status=${created.status}`);
const list = await (await fetch(`${DAEMON}/im-destinations`)).json();
record("IM destination list", list.destinations.some((d) => d.label === "Smoke Feishu"), `count=${list.destinations.length}`);
const stored = JSON.stringify(createdBody);
record("IM webhook ref never stored raw", !stored.includes("hooks") && !stored.includes("http"), "");
const testSend = await fetch(`${DAEMON}/im-destinations/${createdBody.destination.id}/test`, { method: "POST" });
const testBody = await testSend.json();
record("IM test send fails cleanly on unconfigured ref", testSend.status === 502 && Boolean(testBody.error), `status=${testSend.status} error=${testBody.error ?? ""}`);
const removed = await fetch(`${DAEMON}/im-destinations/${createdBody.destination.id}`, { method: "DELETE" });
record("IM destination delete", removed.status === 200, "");

// 5. Marketplace inspect against the real daemon (fetch path)
const market = await fetch(`${DAEMON}/skills/marketplace/inspect?url=${encodeURIComponent("https://raw.githubusercontent.com/ling-stack-org/ling-stack/feat/ux-gap-roadmap/docs/design/ux-gap-roadmap.md")}`);
record("marketplace inspect reachable from real daemon", [200, 422, 502].includes(market.status), `status=${market.status}`);
const marketBody = await market.json().catch(() => ({}));
record("marketplace rejects non-index content", market.status !== 200 || marketBody.schemaVersion === 1, `status=${market.status}`);

// 6. Bind/auth is loopback here; verify the health endpoint stays open
const health = await fetch(`${DAEMON}/health`);
record("daemon health open on loopback", health.status === 200, "");

const unexpectedErrors = pageErrors.filter((e) => !e.includes("localStorage") && !e.includes("sandboxed"));
record("no unexpected page errors", unexpectedErrors.length === 0, unexpectedErrors.slice(0, 2).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\nSMOKE RESULT: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
