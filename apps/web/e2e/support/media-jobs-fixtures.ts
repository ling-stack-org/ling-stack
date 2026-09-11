import type { Page } from "@playwright/test";
import {
  ThemeRegistry,
  lingLightTheme,
  resolvedThemeToBootstrapSnapshot,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { createBaseState } from "./mock-state";
import type { MockArtifact, MockMediaJob, MockState } from "./mock-daemon";

export const mediaFixtureCatalog = [
  "media_empty_no_model",
  "media_mixed_100",
  "media_refresh_stale",
  "media_image_ready",
  "media_video_running",
  "media_video_ready",
  "media_missing_artifact",
  "media_provider_blocked",
  "media_workflow_blocked",
  "media_approval_waiting",
  "media_long_create",
] as const;

export type MediaFixtureId = typeof mediaFixtureCatalog[number];

export function createMediaEmptyFixture(): MockState {
  return createBaseState({});
}

export function createMediaMixedFixture(total = 12): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [imageProvider(), videoProvider(), blockedProvider()];
  state.mediaWorkflowConnections = [workflowConnection()];
  state.mediaWorkflows = [workflowDefinition()];
  const jobs = fixtureJobs();
  for (let index = jobs.length; index < total; index += 1) {
    jobs.push(job(`media_job_extra_${String(index).padStart(3, "0")}`, index % 2 ? "queued" : "failed", {
      prompt: index % 2 ? `Long English generation prompt ${index} ${"continuation ".repeat(8)}` : `长中文生成任务 ${index} ${"用于边界验证".repeat(8)}`,
      errorMessage: index % 2 ? undefined : "Generation failed after a temporary network timeout.",
    }));
  }
  state.mediaJobs = jobs;
  state.artifactsByMediaJob.media_job_image_ready = [
    artifact("artifact_image_primary", "image", "Primary opaque image"),
    artifact("artifact_image_secondary", "image", "Secondary image"),
    artifact("artifact_image_notes", "json", "Generation notes"),
  ];
  state.artifactsByMediaJob.media_job_video_ready = [artifact("artifact_video_ready", "video", "Paused video result", "video/webm")];
  state.artifactsByMediaJob.media_job_preview_unavailable = [artifact("artifact_preview_unavailable", "image", "Unavailable preview")];
  state.approvals.unshift({
    id: "approval_media_waiting",
    mediaJobId: "media_job_approval_waiting",
    actionType: "media_cost",
    risk: "medium",
    title: "Review generation cost",
    description: "Approve this media generation request.",
    payload: {},
    status: "pending",
    createdAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return state;
}

export interface MediaRouteControl {
  failNextList: boolean;
  failNextCreate: boolean;
  listDelayMs: number;
  createDelayMs: number;
  listCalls: number;
  runCalls: Record<string, number>;
}

export function createMediaRouteControl(): MediaRouteControl {
  return { failNextList: false, failNextCreate: false, listDelayMs: 0, createDelayMs: 0, listCalls: 0, runCalls: {} };
}

export async function installMediaScenarioRoutes(page: Page, control: MediaRouteControl): Promise<void> {
  await page.route("**/media-jobs**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.endsWith("/media-jobs")) {
      control.listCalls += 1;
      if (control.listDelayMs) await new Promise((resolve) => setTimeout(resolve, control.listDelayMs));
      if (control.failNextList) {
        control.failNextList = false;
        await route.fulfill({ status: 503, json: { error: "fixture_refresh_failed" } });
        return;
      }
    }
    if (request.method() === "POST" && path.endsWith("/media-jobs")) {
      if (control.createDelayMs) await new Promise((resolve) => setTimeout(resolve, control.createDelayMs));
      if (control.failNextCreate) {
        control.failNextCreate = false;
        await route.fulfill({ status: 503, json: { error: "fixture_create_failed" } });
        return;
      }
    }
    const runMatch = /\/media-jobs\/([^/]+)\/run$/u.exec(path);
    if (request.method() === "POST" && runMatch) {
      const jobId = decodeURIComponent(runMatch[1] ?? "");
      control.runCalls[jobId] = (control.runCalls[jobId] ?? 0) + 1;
    }
    await route.fallback();
  });
  await page.route("**/artifacts/**/content**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("artifact_image_primary") || path.includes("artifact_image_secondary")) {
      await route.fulfill({ contentType: "image/png", body: Buffer.from(deterministicOpaquePngBase64, "base64") });
      return;
    }
    if (path.includes("artifact_video_ready")) {
      await route.fulfill({ contentType: "video/webm", body: Buffer.from(deterministicWebmBase64, "base64") });
      return;
    }
    if (path.includes("artifact_preview_unavailable")) {
      await route.fulfill({ status: 503, body: "preview unavailable" });
      return;
    }
    await route.fallback();
  });
}

export async function openMediaJobs(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /^(Media Production|媒体生产)$/u }).click();
  await page.getByRole("radio", { name: /^(Generation tasks|生成任务)$/u }).click();
}

export async function seedImportedQuietOcean(page: Page): Promise<string> {
  const fixture = importedThemeFixture();
  await page.evaluate(async ({ manifest, selection, snapshot }) => {
    sessionStorage.setItem("ling-stack.e2eThemeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(snapshot));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2");
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("themes")) request.result.createObjectStore("themes", { keyPath: "id" });
        if (!request.result.objectStoreNames.contains("theme-packages")) request.result.createObjectStore("theme-packages", { keyPath: "themeId" });
        if (!request.result.objectStoreNames.contains("theme-assets")) request.result.createObjectStore("theme-assets", { keyPath: "key" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("themes", "readwrite");
        transaction.objectStore("themes").put(manifest);
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
  }, fixture);
  return fixture.manifest.id;
}

function fixtureJobs(): MockMediaJob[] {
  return [
    job("media_job_image_ready", "succeeded", { prompt: "Opaque launch image with multiple supporting results.", artifactIds: ["artifact_image_primary", "artifact_image_secondary", "artifact_image_notes"] }),
    job("media_job_rate_limit", "failed", { prompt: "Rate limited product image.", errorMessage: "HTTP 429 rate limited. token=must-not-render" }),
    job("media_job_video_running", "running", { operation: "video_generate", providerPresetId: "provider_video", prompt: "Running video without percentage or ETA." }),
    job("media_job_video_ready", "succeeded", { operation: "video_generate", providerPresetId: "provider_video", prompt: "Paused video generation result.", artifactIds: ["artifact_video_ready"] }),
    job("media_job_provider_blocked", "failed", { providerPresetId: "provider_blocked", prompt: "Blocked provider task.", errorMessage: "API key missing at /Users/example/private" }),
    job("media_job_workflow_blocked", "failed", { providerPresetId: undefined, workflowVersionId: "workflow_version_1", executionSource: { kind: "workflow", workflowVersionId: "workflow_version_1" }, prompt: "Workflow connection repair.", errorMessage: "ComfyUI connection failed." }),
    job("media_job_workflow_missing", "failed", { providerPresetId: undefined, workflowVersionId: "workflow_version_missing", executionSource: { kind: "workflow", workflowVersionId: "workflow_version_missing" }, prompt: "Missing workflow repair." }),
    job("media_job_approval_waiting", "waiting_for_approval", { prompt: "Approval gated generation.", input: { approvalGate: "media_cost" } }),
    job("media_job_legacy_waiting", "waiting_for_approval", { prompt: "Legacy waiting task remains directly runnable." }),
    job("media_job_preview_unavailable", "succeeded", { prompt: "Metadata exists but image content fails.", artifactIds: ["artifact_preview_unavailable"] }),
    job("media_job_queued", "queued", { prompt: "Ready standalone task." }),
    job("media_job_cancelled", "cancelled", { prompt: "Cancelled historical task." }),
  ];
}

function job(
  id: string,
  status: MockMediaJob["status"],
  overrides: Partial<MockMediaJob> = {},
): MockMediaJob {
  const providerPresetId = overrides.providerPresetId === undefined && !overrides.workflowVersionId ? "provider_image" : overrides.providerPresetId;
  return {
    id,
    workspaceId: "workspace_default",
    providerPresetId,
    executionSource: overrides.executionSource ?? (providerPresetId ? { kind: "provider", providerPresetId } : undefined),
    operation: "image_generate",
    prompt: id,
    input: {},
    artifactIds: [],
    status,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:01:00.000Z",
    ...overrides,
  };
}

function artifact(id: string, type: MockArtifact["type"], title: string, contentType?: string): MockArtifact {
  return { id, mediaJobId: id.replace(/^artifact_/u, "media_job_"), type, path: `fixtures/${id}`, title, contentType, sizeBytes: 4096, createdAt: "2026-07-20T00:02:00.000Z" };
}

function imageProvider(): Record<string, unknown> {
  return { id: "provider_image", kind: "seedream", displayName: "Seedream Production", providerId: "seedream", model: "seedream-4", api: "media-job", baseUrl: "https://example.invalid/v1", apiKeyRef: "env:MEDIA_FIXTURE_KEY", apiKeyConfigured: true, headers: {}, input: ["text", "image"], compat: { mediaVendorTransport: { mode: "live" } }, capabilities: ["image_generate", "image_edit"], enabled: true, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" };
}

function videoProvider(): Record<string, unknown> {
  return { id: "provider_video", kind: "seedance", displayName: "Seedance Production", providerId: "seedance", model: "seedance-1.0-pro", api: "media-job", baseUrl: "https://example.invalid/v1", apiKeyRef: "env:MEDIA_FIXTURE_KEY", apiKeyConfigured: true, headers: {}, input: ["text"], compat: { mediaVendorTransport: { mode: "live" } }, capabilities: ["video_generate"], enabled: true, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" };
}

function blockedProvider(): Record<string, unknown> {
  return { ...imageProvider(), id: "provider_blocked", displayName: "Disabled image route", enabled: false };
}

function workflowConnection(): Record<string, unknown> {
  return { id: "workflow_connection_1", workspaceId: "workspace_default", name: "Comfy fixture", adapterKind: "comfyui", baseUrl: "https://example.invalid/comfy", authMode: "none", secretConfigured: false, networkPolicy: "public_only", protocolVariant: "auto", status: "error", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" };
}

function workflowDefinition(): Record<string, unknown> {
  const version = { id: "workflow_version_1", workflowDefinitionId: "workflow_definition_1", version: 1, sourceFormat: "comfy_api_json", sourceDigest: "fixture", graphSnapshot: {}, inputFields: [], outputRules: [], validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-07-20T00:00:00.000Z" }, createdAt: "2026-07-20T00:00:00.000Z" };
  return { definition: { id: "workflow_definition_1", workspaceId: "workspace_default", connectionId: "workflow_connection_1", name: "Editorial video workflow", status: "ready", currentVersionId: version.id, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" }, currentVersion: version, versions: [version] };
}

function importedThemeFixture(): { readonly manifest: LingThemePackManifest; readonly selection: ThemeSelection; readonly snapshot: NonNullable<ReturnType<typeof resolvedThemeToBootstrapSnapshot>> } {
  const manifest: LingThemePackManifest = { ...structuredClone(lingLightTheme), id: "quiet-ocean", name: "Quiet Ocean", familyId: "quiet-ocean", source: "local-import" };
  const registry = new ThemeRegistry();
  const installed = registry.install(manifest, "local-import", "2026-07-20T00:00:00.000Z");
  if (!installed.ok) throw new Error("Imported theme fixture failed validation.");
  const selection: ThemeSelection = { mode: "fixed", themeId: manifest.id };
  const snapshot = resolvedThemeToBootstrapSnapshot(registry.resolve(selection, "light"));
  if (!snapshot) throw new Error("Imported theme snapshot was not generated.");
  return { manifest, selection, snapshot };
}

const deterministicOpaquePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAACXBIWXMAAAABAAAAAQBPJcTWAAACYUlEQVR4nO3VsQkCURRFQQX7swMLMBBTKzBdDLYAO7C4zS3AROTDenSmgMdNDm+7LMsGaNqtPQD4nIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYcMC3p9vo07Bz3tMpyF3fGAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhLBPw/XpcewJ/5HCZ157wlkzAwCsBQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhLBPw4TKvPQG+TiZg4JWAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGHDAn5Mp1GngDf5wBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUPYE4Q3Dsm0191vAAAAAElFTkSuQmCC";

const deterministicWebmBase64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJAEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggIq7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiEBpAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYi1ApBVa4ZFmZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDgkLCBILqBEpqBAlW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMHNz2mPAi2PFiLUCkFVrhkWZZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMjAwMDAwMDAwAB9DtnX654EAo6GBAACAgkmDQgAB8AEWADgkHBhKAAAwYAAAEN///VkVgACjk4EAKACGAECSnABQAAADIAAAQ0Cjk4EAUACGAECSnABO4AADIAAAQ0Cjk4EAeACGAECSnABQAAADIAAAQ0Cjk4EAoACGAECSnABNQAADIAAAQ0AcU7trkbuPs4EAt4r3gQHxggGr8IED";
