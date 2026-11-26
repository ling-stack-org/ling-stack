import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { createDaemonServer } from "@ling-stack/daemon";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("Review workbench runs a registered browser check and restores the candidate-bound report", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32", "Host verification process-group cleanup is available on macOS and Linux.");
  // The verifier launches a second Chromium process before producing its report.
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-verification-web-")));
  const cwd = join(root, "project");
  const home = join(root, "state");
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = home;
  await mkdir(cwd);
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\nnode_modules/\n");
  const subject = join(cwd, "status.txt");
  await writeFile(subject, "pending\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", ".gitignore", "status.txt");
  git("-c", "user.name=Verification", "-c", "user.email=verification@example.test", "commit", "-qm", "Verification fixture baseline");
  await writeFile(subject, "ready\n");

  const verifier = join(root, "verify-browser.mjs");
  const playwrightModule = import.meta.resolve("@playwright/test");
  const content = [
    'import { createServer } from "node:http";',
    'import { readFileSync } from "node:fs";',
    `import { chromium } from ${JSON.stringify(playwrightModule)};`,
    'const server = createServer((_request, response) => {',
    '  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });',
    '  response.end("<main>" + readFileSync("status.txt", "utf8") + "</main>");',
    '});',
    'await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));',
    'try {',
    '  const browser = await chromium.launch({ headless: true });',
    '  try {',
    '    const page = await browser.newPage();',
    '    await page.goto("http://127.0.0.1:" + server.address().port);',
    '    if ((await page.locator("main").textContent({ timeout: 5_000 })).trim() !== "ready") throw new Error("Unexpected project status");',
    '    console.log("Chromium confirmed the project status");',
    '  } finally { await browser.close(); }',
    '} finally { server.close(); }',
  ].join("\n");
  await writeFile(verifier, content);

  const store = createSqliteRunStore(cwd, resolveStoragePaths(cwd, { homeDir: home, env: {} }).workspace);
  const daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    appServerVerificationRecipes: [{
      id: "browser-status", label: "Browser status check", workspaceRoot: cwd, kind: "browser",
      argv: [process.execPath, verifier], paths: ["status.txt"], required: true,
      verifier: { coverage: "Chromium displays the status from status.txt",
        sources: [{ path: verifier, sha256: createHash("sha256").update(content).digest("hex") }] },
    }],
  }, {
    chromeBrowserNativeMessagingEnabled: false,
    remoteReplyDispatcher: null,
    storeFactory: () => store,
  });
  try {
    await daemon.start();
    const address = daemon.server.address();
    if (!address || typeof address === "string") throw new Error("Verification fixture has no TCP listener.");
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }), { defaultWorkspaceCwd: cwd });
    await page.route("**/workspace/verification?*", async route => {
      const request = route.request();
      const forwarded = new URL(request.url());
      forwarded.host = "127.0.0.1:" + address.port;
      forwarded.searchParams.set("cwd", cwd);
      const threadId = request.method() === "POST" ? request.postDataJSON()?.threadId : forwarded.searchParams.get("threadId");
      if (typeof threadId === "string" && !store.getLingThread(threadId)) {
        store.createLingThread({ id: threadId, kind: "conversation", title: "Browser verification", objective: "Verify the candidate", status: "open" }, new Date().toISOString());
      }
      await route.fulfill({ response: await route.fetch({ url: forwarded.href }) });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    async function openVerification() {
      await openEngineeringChannel(page);
      await page.getByRole("toolbar", { name: "Workspace task toolbar" }).getByRole("button", { name: "Show details" }).click();
      const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
      await dock.getByRole("button", { name: "Review", exact: true }).click();
      await dock.getByRole("button", { name: "Verification", exact: true }).click({ timeout: 10_000 });
      return dock.getByRole("region", { name: "Verification", exact: true });
    }

    await page.goto("/");
    const panel = await openVerification();
    await expect(panel.getByText("Not run", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(panel.getByText("Passed", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText("Browser status check", { exact: true })).toBeVisible();
    await panel.getByText("Check output", { exact: true }).click();
    await expect(panel.getByText("Chromium confirmed the project status", { exact: true })).toBeVisible();

    await writeFile(subject, "changed after verification\n");
    await page.reload();
    const restored = await openVerification();
    await expect(restored.getByText("Candidate changed since verification", { exact: true })).toBeVisible();
    await expect(restored.getByText("Passed", { exact: true }).first()).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
    if (process.env.LING_CAPTURE_UI2_EVIDENCE === "1") {
      await testInfo.attach("verification-report", { body: await page.screenshot(), contentType: "image/png" });
    }
  } finally {
    try { await daemon.stop(); } finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(root, { force: true, recursive: true });
    }
  }
});
