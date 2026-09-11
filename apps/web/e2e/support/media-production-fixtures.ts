import type { Page } from "@playwright/test";
import { createBaseState } from "./mock-state";
import type {
  MockMediaProject,
  MockMediaScene,
  MockState,
} from "./mock-daemon";

export const mediaProductionFixtureCatalog = [
  "production_initial_delay",
  "production_authoritative_empty",
  "production_initial_error",
  "production_retained_error",
  "production_project_race",
  "production_project_delete_failure",
  "production_project_delete_success",
  "production_scene_delete_failure",
  "production_scene_delete_success",
  "production_long_list",
] as const;

export interface MediaProductionRouteControl {
  failNextProjectList: number;
  failNextProjectDetailById: Record<string, number>;
  failNextProjectDelete: number;
  failNextSceneDelete: number;
  projectListDelayMs: number;
  projectListDelayByCwd: Record<string, number>;
  projectDetailDelayById: Record<string, number>;
  projectDeleteDelayMs: number;
  sceneDeleteDelayMs: number;
  projectListCalls: number;
  projectDetailCalls: Record<string, number>;
  projectDeleteCalls: Record<string, number>;
  sceneDeleteCalls: Record<string, number>;
  requestedCwds: string[];
  projectsByCwd: Record<string, readonly MockMediaProject[]>;
}

export function createMediaProductionRouteControl(): MediaProductionRouteControl {
  return {
    failNextProjectList: 0,
    failNextProjectDetailById: {},
    failNextProjectDelete: 0,
    failNextSceneDelete: 0,
    projectListDelayMs: 0,
    projectListDelayByCwd: {},
    projectDetailDelayById: {},
    projectDeleteDelayMs: 0,
    sceneDeleteDelayMs: 0,
    projectListCalls: 0,
    projectDetailCalls: {},
    projectDeleteCalls: {},
    sceneDeleteCalls: {},
    requestedCwds: [],
    projectsByCwd: {},
  };
}

export function createEmptyMediaProductionFixture(): MockState {
  return createBaseState({});
}

export function createLoadedMediaProductionFixture(input: {
  readonly projectCount?: number;
  readonly scenesPerProject?: number;
} = {}): MockState {
  const projectCount = input.projectCount ?? 3;
  const scenesPerProject = input.scenesPerProject ?? 2;
  const state = createBaseState({});
  const timestamp = "2026-07-23T00:00:00.000Z";
  state.mediaProjects = Array.from({ length: projectCount }, (_, index) => mediaProject(index, timestamp));
  state.mediaScenes = state.mediaProjects.flatMap((project, projectIndex) => Array.from(
    { length: scenesPerProject },
    (_, sceneIndex) => mediaScene(project.id, projectIndex, sceneIndex, timestamp),
  ));
  return state;
}

export function createLongMediaProductionFixture(): MockState {
  return createLoadedMediaProductionFixture({ projectCount: 100, scenesPerProject: 1 });
}

export async function installMediaProductionScenarioRoutes(
  page: Page,
  state: MockState,
  control: MediaProductionRouteControl,
): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cwd = url.searchParams.get("cwd") ?? "";
    const path = url.pathname;

    if (request.method() === "GET" && path === "/media-projects") {
      control.projectListCalls += 1;
      control.requestedCwds.push(cwd);
      await delay(control.projectListDelayByCwd[cwd] ?? control.projectListDelayMs);
      if (control.failNextProjectList > 0) {
        control.failNextProjectList -= 1;
        await route.fulfill({ json: { cwd, mediaProjects: null, fixtureError: "media_project_list_failed" } });
        return;
      }
      const projects = control.projectsByCwd[cwd];
      if (projects) {
        await route.fulfill({ json: { cwd, mediaProjects: projects } });
        return;
      }
      await route.fallback();
      return;
    }

    const projectMatch = /^\/media-projects\/([^/]+)$/u.exec(path);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1] ?? "");
      if (request.method() === "GET") {
        control.projectDetailCalls[projectId] = (control.projectDetailCalls[projectId] ?? 0) + 1;
        control.requestedCwds.push(cwd);
        await delay(control.projectDetailDelayById[projectId] ?? 0);
        if ((control.failNextProjectDetailById[projectId] ?? 0) > 0) {
          control.failNextProjectDetailById[projectId] -= 1;
          await route.fulfill({ json: {
            mediaProject: { id: "fixture_project_identity_mismatch" },
            scenes: [],
            sceneRuns: [],
          } });
          return;
        }
      }
      if (request.method() === "DELETE") {
        control.projectDeleteCalls[projectId] = (control.projectDeleteCalls[projectId] ?? 0) + 1;
        control.requestedCwds.push(cwd);
        await delay(control.projectDeleteDelayMs);
        if (control.failNextProjectDelete > 0) {
          control.failNextProjectDelete -= 1;
          await route.fulfill({
            status: 500,
            json: { code: "media_project_delete_failed", error: "media_project_delete_failed" },
          });
          return;
        }
        state.mediaProjects = state.mediaProjects.filter((project) => project.id !== projectId);
        state.mediaScenes = state.mediaScenes.filter((scene) => scene.projectId !== projectId);
        await route.fulfill({ json: { deleted: true, mediaProjectId: projectId } });
        return;
      }
      await route.fallback();
      return;
    }

    const sceneMatch = /^\/media-scenes\/([^/]+)$/u.exec(path);
    if (request.method() === "DELETE" && sceneMatch) {
      const sceneId = decodeURIComponent(sceneMatch[1] ?? "");
      control.sceneDeleteCalls[sceneId] = (control.sceneDeleteCalls[sceneId] ?? 0) + 1;
      control.requestedCwds.push(cwd);
      await delay(control.sceneDeleteDelayMs);
      if (control.failNextSceneDelete > 0) {
        control.failNextSceneDelete -= 1;
        await route.fulfill({
          status: 500,
          json: { code: "media_scene_delete_failed", error: "media_scene_delete_failed" },
        });
        return;
      }
      state.mediaScenes = state.mediaScenes.filter((scene) => scene.id !== sceneId);
      await route.fulfill({ json: { deleted: true, mediaSceneId: sceneId } });
      return;
    }

    await route.fallback();
  });
}

export async function openMediaProduction(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Media Production" }).click();
}

function mediaProject(index: number, timestamp: string): MockMediaProject {
  const suffix = String(index + 1).padStart(3, "0");
  return {
    id: `media_project_ui2_${suffix}`,
    workspaceId: "workspace_default",
    name: `Editorial project ${suffix}`,
    defaultExecutionMode: "direct",
    canvasViewport: { x: 0, y: 0, zoom: 1 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mediaScene(
  projectId: string,
  projectIndex: number,
  sceneIndex: number,
  timestamp: string,
): MockMediaScene {
  const suffix = `${String(projectIndex + 1).padStart(3, "0")}_${String(sceneIndex + 1).padStart(2, "0")}`;
  return {
    id: `media_scene_ui2_${suffix}`,
    projectId,
    sortOrder: sceneIndex,
    title: `Scene ${suffix}`,
    prompt: `Editorial shot ${suffix}`,
    executionMode: "inherit",
    workflowInputValues: {},
    ratio: "16:9",
    durationSeconds: 5,
    referenceArtifactIds: [],
    canvasPosition: { x: 80 + sceneIndex * 280, y: 96 + projectIndex * 12 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
