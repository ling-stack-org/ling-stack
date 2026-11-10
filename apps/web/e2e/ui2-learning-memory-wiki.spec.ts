import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { LearningReviewJob, MemoryObject, MemorySemanticPolicyResponse, MemoryWikiResponse, MemoryWikiScope } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd } from "./support/mock-state";

const workspaceScope: MemoryWikiScope = { scopeType: "workspace", ownerId: "workspace_default" };

// Value: protects=Wiki notes survive a learning refresh and CAS conflicts, save, rebuild and export;
// fails_when=a parent refresh overwrites edits or a failed CAS discards notes;
// why_new=daemon tests bypass the browser editor lifecycle and download wiring; seam=none;
// no_claim=storage durability or daemon authorization (HTTP responses are mocked).
test("human Wiki notes survive learning refresh, conflicts, rebuild and Markdown export", async ({ page }) => {
  let refreshing = false;
  let holdInitialRead = true;
  const initialReads: Route[] = [];
  let wiki = wikiFixture(workspaceScope);
  const pendingWikiReads: Route[] = [];
  const saves: { scope: Record<string, string>; body: unknown }[] = [];
  let failSave = true;
  await prepareLearning(page, async (route, path) => {
    if (path === "/skills/learning-policy") {
      await route.fulfill({ json: { cwd, policy: { mode: refreshing ? "propose" : "off", revision: refreshing ? 2 : 1 } } });
      return true;
    }
    if (path === "/memory/wiki") {
      if (holdInitialRead) {
        initialReads.push(route);
        return true;
      }
      if (refreshing) {
        pendingWikiReads.push(route);
        return true;
      }
      await route.fulfill({ json: wiki });
      return true;
    }
    if (path === "/memory/wiki/compile") {
      // Release refresh reads before the user-visible rebuild completes. Fixed
      // browsers may have no redundant read, so the fixture works in both cases.
      await Promise.all(pendingWikiReads.splice(0).map(read => read.fulfill({ json: wiki })));
      wiki = { ...wiki, generation: (wiki.generation ?? 0) + 1,
        pages: [wikiPage(workspaceScope, "rebuild", "Rebuild completed", "The approved source is unchanged.")] };
      await route.fulfill({ json: wiki });
      return true;
    }
    if (path === "/memory/wiki/human") {
      const body = route.request().postDataJSON() as { expectedRevision: number; text: string };
      saves.push({ scope: Object.fromEntries(new URL(route.request().url()).searchParams), body });
      if (failSave) {
        await route.fulfill({ status: 409, json: { error: "memory_wiki_notes_conflict", message: "Notes changed in another window." } });
      } else {
        wiki = { ...wiki, human: { revision: body.expectedRevision + 1, text: body.text } };
        await route.fulfill({ json: { cwd, scope: workspaceScope, human: wiki.human } });
      }
      return true;
    }
    if (path === "/memory/wiki/export") {
      await route.fulfill({ json: { fileName: "workspace-knowledge.md", generation: wiki.generation,
        markdown: `# Workspace knowledge\n\n## Human notes\n\n${wiki.human.text}\n` } });
      return true;
    }
    return false;
  });
  const panel = await openLearning(page);
  await panel.getByText("Knowledge Wiki", { exact: true }).click();
  const notes = panel.getByLabel("Human notes", { exact: true });
  await expect.poll(() => initialReads.length).toBeGreaterThan(0);
  await expect(notes).toBeDisabled();
  // Rebuilding before the first GET finishes could enable editing, after which
  // that older GET would overwrite the draft and its CAS revision.
  await expect(panel.getByRole("button", { name: "Rebuild Wiki", exact: true })).toBeDisabled();
  holdInitialRead = false;
  await Promise.all(initialReads.splice(0).map(read => read.fulfill({ json: wiki })));
  await expect(notes).toHaveValue("Existing source note");
  await notes.fill("Keep the signed receipt convention through every rebuild.");
  refreshing = true;
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(panel.getByText("Automatic proposals enabled", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Rebuild Wiki", exact: true }).click();
  await expect(panel.getByText("Rebuild completed", { exact: true })).toBeVisible();
  await expect(notes).toHaveValue("Keep the signed receipt convention through every rebuild.");
  const save = panel.getByRole("button", { name: "Save notes", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(panel.getByText("Notes changed in another window.", { exact: true })).toBeVisible();
  await expect(notes).toHaveValue("Keep the signed receipt convention through every rebuild.");
  await expect(save).toBeEnabled();
  failSave = false;
  await save.click();
  await expect(save).toBeDisabled();
  expect(saves).toEqual([0, 1].map(() => ({ scope: { cwd, ...workspaceScope },
    body: { expectedRevision: 3, text: "Keep the signed receipt convention through every rebuild." } })));
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/memory/wiki/compile"),
    panel.getByRole("button", { name: "Rebuild Wiki", exact: true }).click(),
  ]);
  await expect(notes).toHaveValue("Keep the signed receipt convention through every rebuild.");
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export Markdown", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("workspace-knowledge.md");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, "utf8")).toContain("Keep the signed receipt convention through every rebuild.");
});

// Value: protects=Wiki scope switches ignore old responses and keep search and topic filters within the selected owner;
// fails_when=a delayed channel response replaces workspace knowledge or filters show unrelated pages;
// why_new=server isolation tests do not exercise browser selection or stale HTTP completions; seam=none;
// no_claim=server-side scope authorization (HTTP responses are mocked).
test("Wiki scope switching rejects delayed old results and filters the current knowledge", async ({ page }) => {
  const channelScope: MemoryWikiScope = { scopeType: "channel", ownerId: "channel_engineering" };
  const pendingChannelReads: Route[] = [];
  const reads: Record<string, string>[] = [];
  const workspaceWiki: MemoryWikiResponse = { ...wikiFixture(workspaceScope), pages: [
    wikiPage(workspaceScope, "receipts", "Workspace receipts", "Signed invoice receipts are retained."),
    wikiPage(workspaceScope, "releases", "Workspace releases", "Check the release manifest."),
  ], topics: [{ key: "finance", pageIds: ["receipts"] }, { key: "shipping", pageIds: ["releases"] }] };
  const channelWiki: MemoryWikiResponse = { ...wikiFixture(channelScope), pages: [
    wikiPage(channelScope, "incident", "Channel-only incident", "Do not display this in workspace knowledge."),
  ] };
  await prepareLearning(page, async (route, path) => {
    if (path !== "/memory/wiki") return false;
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    reads.push(query);
    if (query.scopeType === "channel") pendingChannelReads.push(route);
    else await route.fulfill({ json: workspaceWiki });
    return true;
  });
  const panel = await openLearning(page);
  await panel.getByText("Knowledge Wiki", { exact: true }).click();
  const select = panel.getByLabel("Knowledge scope", { exact: true });
  await expect(select.getByRole("option", { name: "Channel · Engineering", exact: true })).toHaveCount(1);
  await expect(panel.getByText("Workspace receipts", { exact: true })).toBeVisible();
  await select.selectOption(JSON.stringify(channelScope));
  await expect.poll(() => pendingChannelReads.length).toBeGreaterThan(0);
  await select.selectOption(JSON.stringify(workspaceScope));
  await expect(panel.getByText("Workspace receipts", { exact: true })).toBeVisible();
  await Promise.all(pendingChannelReads.splice(0).map(route => route.fulfill({ json: channelWiki })));
  const search = panel.getByLabel("Search Wiki", { exact: true });
  await search.fill("release manifest");
  await expect(panel.getByText("Workspace releases", { exact: true })).toBeVisible();
  await expect(panel.getByText("Workspace receipts", { exact: true })).toHaveCount(0);
  await search.fill("");
  await panel.getByLabel("Topic", { exact: true }).selectOption("finance");
  await expect(panel.getByText("Workspace receipts", { exact: true })).toBeVisible();
  await expect(panel.getByText("Workspace releases", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Channel-only incident", { exact: true })).toHaveCount(0);
  await expect(select).toHaveValue(JSON.stringify(workspaceScope));
  expect(reads.every(query => query.cwd === cwd)).toBe(true);
  expect(reads).toContainEqual({ cwd, ...channelScope });
  expect(reads).toContainEqual({ cwd, ...workspaceScope });
});

// Value: protects=learning memory review keeps its source owner and preserves approved state after an archive error;
// fails_when=review requests promote scope, hide errors or show approval before a successful response;
// why_new=API tests bypass candidate cards and their approve/archive state transitions; seam=none;
// no_claim=daemon review authorization or persistence (HTTP responses are mocked).
test("learning memory approval and archive retain the original owner and recover from errors", async ({ page }) => {
  const memoryId = "memory_receipt / 中文";
  let memory: MemoryObject = { id: memoryId, workspaceId: "workspace_default", scopeType: "channel", ownerId: "channel_engineering",
    title: "Signed receipts", body: "Use the signed receipt when reconciling.", tags: [],
    sourceRefs: [{ type: "run", id: "run_verified" }], reviewState: "candidate", enabled: true, sensitivity: "normal",
    verifyBeforeUse: false, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" };
  const calls: { path: string; method: string; query: Record<string, string>; body: unknown }[] = [];
  let failArchive = true;
  await prepareLearning(page, async (route, path) => {
    if (path === "/skills/learning-reviews") {
      await route.fulfill({ json: { cwd, jobs: [learningJob([memoryId])] } });
      return true;
    }
    if (decodeURIComponent(path) === `/memory/${memoryId}`) {
      await route.fulfill({ json: { cwd, memory } });
      return true;
    }
    if (decodeURIComponent(path) === `/memory/${memoryId}/review`) {
      const body = route.request().postDataJSON() as { action: "approve" | "archive"; actor: string };
      calls.push({ path, method: route.request().method(), query: Object.fromEntries(new URL(route.request().url()).searchParams), body });
      if (body.action === "archive" && failArchive) {
        await route.fulfill({ status: 503, json: { message: "Archive could not be saved." } });
      } else {
        memory = { ...memory, reviewState: body.action === "approve" ? "active" : "archived" };
        await route.fulfill({ json: { cwd, memory } });
      }
      return true;
    }
    return false;
  });
  const panel = await openLearning(page);
  const candidate = panel.locator("[data-learning-memory-id]");
  await expect(candidate.getByText("Memory awaiting review: Signed receipts", { exact: true })).toBeVisible();
  await expect(candidate.getByText("channel · channel_engineering", { exact: true })).toBeVisible();
  await candidate.getByText("Sources", { exact: true }).click();
  await expect(candidate.getByText("run · run_verified", { exact: true })).toBeVisible();
  await candidate.getByRole("button", { name: "Approve memory", exact: true }).click();
  await expect(candidate.getByText("Memory approved: Signed receipts", { exact: true })).toBeVisible();
  await expect(candidate.getByRole("button", { name: "Approve memory", exact: true })).toHaveCount(0);
  await candidate.getByRole("button", { name: "Archive memory", exact: true }).click();
  await expect(candidate.getByText("Archive could not be saved.", { exact: true })).toBeVisible();
  await expect(candidate.getByText("Memory approved: Signed receipts", { exact: true })).toBeVisible();
  failArchive = false;
  await candidate.getByRole("button", { name: "Archive memory", exact: true }).click();
  await expect(candidate.getByText("Memory archived: Signed receipts", { exact: true })).toBeVisible();
  await expect(candidate.getByText("channel · channel_engineering", { exact: true })).toBeVisible();
  await expect(candidate.getByRole("button", { name: "Archive memory", exact: true })).toHaveCount(0);
  expect(calls).toEqual(["approve", "archive", "archive"].map(action => ({
    path: `/memory/${encodeURIComponent(memoryId)}/review`, method: "POST", query: { cwd }, body: { action, actor: "local-user" },
  })));
});

// Value: protects=semantic settings require separate remote/private opt-ins and retain edits on CAS conflict;
// fails_when=remote opt-out keeps private access or a failed save loses fields or revision;
// why_new=client transport tests do not exercise consent controls, failure recovery or disable actions; seam=none;
// no_claim=embedding service acceptance or private-data enforcement (HTTP responses are mocked).
test("semantic settings preserve consent and edits across conflicts and can be disabled", async ({ page }) => {
  let configuration: MemorySemanticPolicyResponse = { cwd, policy: { revision: 4, mode: "off" },
    status: { status: "not_configured", optional: true } };
  const calls: unknown[] = [];
  let failSave = true;
  await prepareLearning(page, async (route, path) => {
    if (path === "/providers") {
      await route.fulfill({ json: { cwd, providers: [createChatProvider({ id: "embedding_remote", displayName: "Remote embeddings",
        reasoning: false, baseUrl: "https://embeddings.example.test/v1" })] } });
      return true;
    }
    if (path !== "/memory/semantic-policy") return false;
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      calls.push({ query: Object.fromEntries(new URL(route.request().url()).searchParams), input });
      if (failSave) {
        await route.fulfill({ status: 409, json: { error: "memory_semantic_policy_conflict", message: "Semantic settings changed in another window." } });
        return true;
      }
      const { expectedRevision, ...policy } = input;
      configuration = { cwd, policy: { ...policy, revision: expectedRevision + 1 },
        status: { status: policy.mode === "off" ? "not_configured" : "ready", optional: true } };
    }
    await route.fulfill({ json: configuration });
    return true;
  });
  const panel = await openLearning(page);
  await panel.getByText("Memory retrieval settings", { exact: true }).click();
  const remote = panel.getByRole("checkbox", { name: "Allow sending approved memory and queries to a remote embedding service", exact: true });
  const privateRemote = panel.getByRole("checkbox", { name: "Also allow private memory and private chat queries remotely", exact: true });
  const remoteLabel = panel.getByText("Allow sending approved memory and queries to a remote embedding service", { exact: true });
  const privateLabel = panel.getByText("Also allow private memory and private chat queries remotely", { exact: true });
  await expect(remote).not.toBeChecked();
  await expect(privateRemote).not.toBeChecked();
  await expect(privateRemote).toBeDisabled();
  await panel.getByLabel("Embedding provider", { exact: true }).selectOption("embedding_remote");
  await panel.getByLabel("Embedding model", { exact: true }).fill("text-embedding-fixture");
  await panel.getByLabel("Vector dimensions", { exact: true }).fill("768");
  await panel.getByLabel("Maximum cosine distance", { exact: true }).fill("0.25");
  await remoteLabel.click();
  await privateLabel.click();
  await remoteLabel.click();
  await expect(privateRemote).not.toBeChecked();
  await expect(privateRemote).toBeDisabled();
  await remoteLabel.click();
  await expect(privateRemote).not.toBeChecked();
  await privateLabel.click();
  const save = panel.getByRole("button", { name: "Save semantic retrieval settings", exact: true });
  await save.click();
  await expect(panel.getByText("Semantic settings changed in another window.", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Embedding provider", { exact: true })).toHaveValue("embedding_remote");
  await expect(panel.getByLabel("Embedding model", { exact: true })).toHaveValue("text-embedding-fixture");
  await expect(panel.getByLabel("Vector dimensions", { exact: true })).toHaveValue("768");
  await expect(panel.getByLabel("Maximum cosine distance", { exact: true })).toHaveValue("0.25");
  await expect(remote).toBeChecked();
  await expect(privateRemote).toBeChecked();
  failSave = false;
  await save.click();
  const disable = panel.getByRole("button", { name: "Disable semantic retrieval", exact: true });
  await expect(disable).toBeEnabled();
  await disable.click();
  await expect(disable).toBeDisabled();
  await expect(panel.getByText("Index status: not_configured", { exact: true })).toBeVisible();
  const expected = { providerPresetId: "embedding_remote", model: "text-embedding-fixture", dimensions: 768, maxDistance: 0.25,
    allowRemote: true, allowPrivateRemote: true, timeoutMs: 1000 };
  expect(calls).toEqual([
    { query: { cwd }, input: { ...expected, expectedRevision: 4, mode: "lancedb" } },
    { query: { cwd }, input: { ...expected, expectedRevision: 4, mode: "lancedb" } },
    { query: { cwd }, input: { ...expected, expectedRevision: 5, mode: "off" } },
  ]);
});

async function prepareLearning(page: Page, override: (route: Route, path: string) => Promise<boolean>): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ reasoning: false })];
  await mockDaemon(page, state);
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (await override(route, path)) return;
    if (path === "/skills/learning-reviews") {
      await route.fulfill({ json: { cwd, jobs: [] } });
      return;
    }
    if (path === "/skills/learning-policy") {
      await route.fulfill({ json: { cwd, policy: { mode: "off", revision: 1 } } });
      return;
    }
    if (path === "/memory/semantic-policy") {
      await route.fulfill({ json: { cwd, policy: { revision: 1, mode: "off" }, status: { status: "not_configured", optional: true } } });
      return;
    }
    await route.fallback();
  });
}

async function openLearning(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("complementary", { name: "Sidebar display" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Skill library", exact: true }).click();
  const library = page.locator("[data-ui2-skill-library]");
  await library.getByRole("tab", { name: /AI evolution/ }).click();
  await library.getByText("Experience review", { exact: true }).click();
  const panel = library.getByRole("region", { name: "Experience review", exact: true });
  await expect(panel.getByText("Automatic learning is off", { exact: true })).toBeVisible();
  return panel;
}

function wikiFixture(scope: MemoryWikiScope): MemoryWikiResponse {
  return {
    cwd, scope, status: "ready", generation: 1, fingerprint: "fixture-1", pages: [], topics: [], sources: [], reports: [],
    human: { revision: 3, text: "Existing source note" },
  };
}

function wikiPage(scope: MemoryWikiScope, id: string, title: string, body: string) {
  return { id, title, body, scope, sourceType: "memory" as const, sourceId: `memory_${id}`, sourceVersion: "v1",
    evidence: [{ type: "run" as const, id: "run_verified" }], confidence: "user_confirmed" as const,
    tags: [], updatedAt: "2026-10-29T00:00:00.000Z", relatedIds: [] };
}

function learningJob(candidateIds: readonly string[]): LearningReviewJob {
  return { id: "learning_receipts", workspaceId: "workspace_default", sourceKey: "run:run_verified", mode: "explicit",
    policyRevision: 1, providerPresetId: "provider_local", status: "succeeded", modelRequests: 1,
    inputTokensReserved: 512, outputTokensReserved: 256, candidateIds,
    limits: { maxRequests: 2, inputTokens: 16000, outputTokens: 4096, perRequestOutputTokens: 2048, timeoutMs: 120000, dailyAutomaticJobs: 10 },
    evidence: { schemaVersion: 1, workspaceId: "workspace_default", runId: "run_verified", channelId: "channel_engineering",
      runStatus: "succeeded", sourceUpdatedAt: "2026-10-29T00:00:00.000Z", eventCount: 1, digest: "fixture",
      items: [{ id: "event_verified", kind: "run_end", text: "Receipt verification passed.", verified: true }], missing: [] },
    createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" };
}
