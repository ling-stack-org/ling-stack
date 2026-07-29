import type { MediaScene } from "../../types.js";
import type { MediaProductionView } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";

export type MediaProductionToolbarActionKind = "none" | "configure" | "review" | "run";

export interface TranslationDescriptor {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface MediaProductionToolbarActionProjection {
  readonly kind: MediaProductionToolbarActionKind;
  readonly label: TranslationDescriptor;
  readonly countLabel?: TranslationDescriptor;
  readonly busy: boolean;
}

export interface MediaProductionToolbarProjection {
  readonly projectName?: string;
  readonly projectLabel: TranslationDescriptor;
  readonly sceneCountLabel?: TranslationDescriptor;
  readonly view: MediaProductionView;
  readonly action: MediaProductionToolbarActionProjection;
}

export interface StoryboardSceneProjection {
  readonly scene: MediaScene;
  readonly order: number;
  readonly readiness?: SceneReadiness;
  readonly statusLabel: TranslationDescriptor;
}

export function deriveMediaProductionToolbarProjection(input: {
  readonly projectName?: string;
  readonly sceneCount: number;
  readonly view: MediaProductionView;
  readonly readyCount: number;
  readonly hasGenerationSource: boolean;
  readonly runBusy: boolean;
}): MediaProductionToolbarProjection {
  const projectName = input.projectName?.trim() || undefined;
  const sceneCount = Math.max(0, Math.trunc(input.sceneCount));
  const readyCount = Math.max(0, Math.trunc(input.readyCount));
  return {
    projectName,
    projectLabel: { key: "Projects and scenes" },
    sceneCountLabel: projectName ? { key: "{count} scenes", values: { count: sceneCount } } : undefined,
    view: input.view,
    action: deriveToolbarAction({
      hasProject: Boolean(projectName),
      hasGenerationSource: input.hasGenerationSource,
      readyCount,
      runBusy: input.runBusy,
      view: input.view,
    }),
  };
}

export function isMediaProductionView(value: string): value is MediaProductionView {
  return value === "studio" || value === "jobs";
}

export function projectStoryboardScenes(
  scenes: readonly MediaScene[],
  readiness: readonly SceneReadiness[],
): readonly StoryboardSceneProjection[] {
  const readinessByScene = new Map(readiness.map((item) => [item.sceneId, item]));
  return scenes
    .slice()
    .sort(compareStoryboardScenes)
    .map((scene, index) => {
      const sceneReadiness = readinessByScene.get(scene.id);
      return {
        scene,
        order: index + 1,
        readiness: sceneReadiness,
        statusLabel: sceneReadiness
          ? { key: sceneReadiness.labelKey, values: sceneReadiness.labelValues }
          : { key: "Needs setup" },
      };
    });
}

export function storyboardFocusSceneIds(
  scenes: readonly StoryboardSceneProjection[],
  sceneId: string,
): readonly string[] {
  const index = scenes.findIndex((item) => item.scene.id === sceneId);
  if (index < 0) return sceneId ? [sceneId] : [];
  return scenes
    .slice(Math.max(0, index - 1), Math.min(scenes.length, index + 2))
    .map((item) => item.scene.id);
}

function deriveToolbarAction(input: {
  readonly hasProject: boolean;
  readonly hasGenerationSource: boolean;
  readonly readyCount: number;
  readonly runBusy: boolean;
  readonly view: MediaProductionView;
}): MediaProductionToolbarActionProjection {
  if (!input.hasProject || input.view !== "studio") {
    return { kind: "none", label: { key: "" }, busy: false };
  }
  if (!input.hasGenerationSource) {
    return { kind: "configure", label: { key: "Configure video model" }, busy: false };
  }
  if (input.readyCount === 0) {
    return { kind: "review", label: { key: "Check" }, busy: input.runBusy };
  }
  return {
    kind: "run",
    label: { key: "Run" },
    countLabel: { key: "{count} scenes", values: { count: input.readyCount } },
    busy: input.runBusy,
  };
}

function compareStoryboardScenes(left: MediaScene, right: MediaScene): number {
  return left.sortOrder - right.sortOrder
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}
