import { expect, test as base, type Locator, type Page } from "@playwright/test";

export interface LiveManifest {
  daemonUrl: string;
  daemonAuthToken: string;
  workspaceCwd: string;
  workspaceId: string;
  channelId: string;
  workflowId: string;
  threadId: string;
  sourceTurnId: string;
  sourceMessageId: string;
  stepIds: Record<string, string>;
  roundId: string;
}

export interface LiveStatus {
  manifest: LiveManifest;
  workflow: { id: string; status: string };
  sourceTurn: { id: string; status: string };
  steps: { id: string; status: string; runId?: string }[];
  runs: {
    run: { id: string; status: string; cwd: string };
    completion?: { drainedAt?: string };
    slots: unknown[];
  }[];
  executions: { runId: string; branch: string; reached: boolean; sdkSettled: boolean; returned: boolean; writes: unknown[] }[];
  approvals: { id: string; actionType: string; risk: string }[];
  target: { head: string; status: string; files: string[] };
  initialTarget: { head: string; status: string; files: string[] };
  selection?: { phase: string; roundId: string };
  round: { phase: string; inputs: { mode: "candidate_only" | "apply_to_target" }; candidate?: { commit: string } };
  parent: { state: string };
  reports: { resultItemId?: string }[];
  errors: string[];
}

type LiveCommand = { op: "status" } | { op: "check"; kind: "ready" | "approvals" | "parallel" | "retained" | "cancelled" | "drained" | "succeeded" }
  | { op: "release"; gate: "provider" | "host" | "all"; branch?: "prepare" | "left" | "right" | "all" }
  | { op: "restart" };

interface LiveFixture {
  readonly manifest: LiveManifest;
  command(input: LiveCommand): Promise<unknown>;
  close(): Promise<void>;
}

export interface LiveScenario {
  fixture: LiveFixture;
  status(): Promise<LiveStatus>;
  check(kind: Extract<LiveCommand, { op: "check" }>["kind"]): Promise<void>;
}

// This import executes in Playwright's Node worker, never in the page or Vite.
const fixtureUrl = new URL("../../../../packages/daemon/test/support/workflow-isolation-live-fixture.mjs", import.meta.url).href;

export const test = base.extend<{ live: LiveScenario; publicSelection: boolean }>({
  publicSelection: [false, { option: true }],
  live: [async ({ publicSelection }, use, testInfo) => {
    const { startWorkflowIsolationLiveFixture } = await import(fixtureUrl);
    const fixture: LiveFixture = await startWorkflowIsolationLiveFixture({ holdReturn: true, publicSelection });
    const status = async () => await fixture.command({ op: "status" }) as LiveStatus;
    const check: LiveScenario["check"] = async kind => {
      await expect.poll(async () => {
        try { await fixture.command({ op: "check", kind }); return "ok"; }
        catch (error) { return String(error); }
      }, { timeout: 45_000, message: `Real daemon fixture check: ${kind}` }).toBe("ok");
    };
    try {
      await use({ fixture, status, check });
    } finally {
      try {
        await testInfo.attach("live-daemon-status", {
          body: JSON.stringify(await status(), null, 2), contentType: "application/json",
        });
      } finally {
        await fixture.close();
      }
    }
  }, { timeout: 120_000 }],
});

export async function openLiveWorkflow(page: Page, live: LiveScenario): Promise<void> {
  await page.addInitScript(manifest => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", manifest.workspaceCwd);
    Object.defineProperty(window, "lingDesktop", { configurable: true, value: {
      platform: "macos", daemonBaseUrl: manifest.daemonUrl,
      daemon: { onStatusChanged(listener: (value: unknown) => void) {
        listener({ state: "connected", baseUrl: manifest.daemonUrl, ownedByDesktop: true });
        return () => {};
      } },
    } });
  }, live.fixture.manifest);
  await page.goto("/");
  await selectLiveConversation(page, live.fixture.manifest);
  await expect(workflowRow(page, live.fixture.manifest).getByRole("button", {
    name: "P3 live Pi Host isolated writes · Pending. Expand details", exact: true,
  })).toBeVisible();
}

export async function selectLiveConversation(page: Page, manifest: LiveManifest): Promise<void> {
  await page.locator(`[aria-label="P3 live isolated writing siblings"]`).click();
  const session = page.locator(`.sidebar-channel-group`).filter({
    has: page.getByRole("button", { name: "P3 live isolated writing siblings", exact: true }),
  }).getByTitle("Default conversation", { exact: true });
  await expect(session).toBeVisible();
  await session.click();
  await expect(page.locator(`[data-session-id="${manifest.threadId}"] button[title="Default conversation"]`)).toHaveAttribute("aria-current", "page");
}

export function workflowRow(page: Page, manifest: LiveManifest): Locator {
  return page.locator(`[data-conversation-timeline-item="protocolEvent"][data-conversation-source-refs*="channel_workflow:${manifest.workflowId}"]`);
}

export function integrationRoundRow(page: Page, manifest: LiveManifest): Locator {
  return page.locator(`[data-conversation-timeline-id="workflow-isolation:${manifest.workflowId}:round:${manifest.roundId}:1"]`);
}

export async function expandRow(row: Locator): Promise<void> {
  const disclosure = row.locator(".conversation-timeline-activity-main");
  await expect(disclosure).toBeVisible();
  if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
}

export async function startAndApproveWrites(page: Page, live: LiveScenario): Promise<void> {
  await live.check("ready");
  const row = workflowRow(page, live.fixture.manifest);
  await expandRow(row);
  await row.getByRole("button", { name: "Advance workflow", exact: true }).click();
  await live.check("approvals");
  const approvals = (await live.status()).approvals.filter(item => item.actionType === "write");
  expect(approvals).toHaveLength(2);
  const remaining = new Set(approvals.map(approval => approval.id));
  for (let index = 0; index < approvals.length; index += 1) {
    const gate = page.locator('[data-runtime-approval-id][data-surface="channel"]');
    await expect(gate).toBeVisible();
    const approvalId = await gate.getAttribute("data-runtime-approval-id");
    expect(remaining.has(approvalId!)).toBe(true);
    await gate.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(async () => (await live.status()).approvals.some(item => item.id === approvalId)).toBe(false);
    remaining.delete(approvalId!);
  }
  expect(remaining.size).toBe(0);
  await live.check("parallel");
}

export async function observeLiveDaemon(page: Page, live: LiveScenario) {
  const manifest = live.fixture.manifest;
  const cdp = await page.context().newCDPSession(page);
  const streams = new Set<string>();
  const events: { eventName: string; eventId: string; data: string }[] = [];
  const mutations: { method: string; path: string; body: string | null }[] = [];
  const pageErrors: string[] = [];
  const workspaceRequests: { method: string; path: string; cwd: string }[] = [];
  const origin = new URL(manifest.daemonUrl).origin;
  cdp.on("Network.requestWillBeSent", event => {
    const url = new URL(event.request.url);
    if (url.origin === origin && url.pathname === "/control-plane/stream") streams.add(event.requestId);
  });
  cdp.on("Network.eventSourceMessageReceived", event => {
    if (streams.has(event.requestId)) events.push({ eventName: event.eventName, eventId: event.eventId, data: event.data });
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    const cwd = url.searchParams.get("cwd");
    if (cwd !== null) workspaceRequests.push({ method: request.method(), path: url.pathname, cwd });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      mutations.push({ method: request.method(), path: url.pathname, body: request.postData() });
    }
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await cdp.send("Network.enable");
  return { events, mutations, pageErrors, workspaceRequests,
    async ready() {
      await expect.poll(() => events.filter(event => event.eventName === "control_plane_replay_ready").length).toBeGreaterThan(0);
    },
    async assertHealthy() {
      const executionRoots = new Set((await live.status()).runs.map(item => item.run.cwd));
      expect(workspaceRequests.filter(item => item.cwd !== manifest.workspaceCwd
        && !(item.method === "GET" && item.path === "/workspace/changes" && executionRoots.has(item.cwd)))).toEqual([]);
      expect(pageErrors).toEqual([]);
      await expect.poll(() => events.filter(event => event.eventName === "control_plane_event").length).toBeGreaterThan(0);
      expect(mutations.filter(item => item.path === `/workflows/${manifest.workflowId}/orchestrate`)).toHaveLength(1);
    },
  };
}
