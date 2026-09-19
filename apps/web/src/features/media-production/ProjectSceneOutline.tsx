import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  FolderCog,
  FolderPlus,
  Plus,
  Settings2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { MediaProject, MediaScene, MediaWorkflowDefinitionDetail, ProviderPreset } from "../../types.js";
import { selectMediaProductionFailure } from "./media-production-project-view-models.js";
import type {
  MediaProductionActions,
  MediaProductionBusyState,
  MediaProductionFailure,
  MediaProductionProjectDetail,
} from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";

export function ProjectSceneOutline({
  actions,
  busy,
  failures,
  onClose,
  onConfigureVideoModel,
  onOpenWorkflowLibrary,
  onRequestProjectDelete,
  onRequestSceneDelete,
  onSceneSelect,
  pendingProjectId,
  project,
  projects,
  providers,
  readiness,
  selectedProjectId,
  selectedSceneId,
  workflows,
}: {
  readonly actions: MediaProductionActions;
  readonly busy: MediaProductionBusyState;
  readonly failures: readonly MediaProductionFailure[];
  readonly onClose: () => void;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
  readonly onRequestProjectDelete: (project: MediaProject, trigger: HTMLElement) => void;
  readonly onRequestSceneDelete: (scene: MediaScene, trigger: HTMLElement) => void;
  readonly onSceneSelect: (sceneId: string) => void;
  readonly pendingProjectId: string;
  readonly project: MediaProductionProjectDetail;
  readonly projects: readonly MediaProject[];
  readonly providers: readonly ProviderPreset[];
  readonly readiness: readonly SceneReadiness[];
  readonly selectedProjectId: string;
  readonly selectedSceneId: string;
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
}): React.JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState(project.mediaProject.name);
  const readinessByScene = useMemo(() => new Map(readiness.map((item) => [item.sceneId, item])), [readiness]);
  const videoProviders = useMemo(
    () => providers.filter((provider) => resolveMediaProviderRuntimeState(provider, "video_generate").canRun),
    [providers],
  );
  const defaultProvider = videoProviders.find((provider) => provider.id === project.mediaProject.defaultProviderPresetId);
  const readyWorkflows = workflows.filter((item) => item.definition.status === "ready" && item.currentVersion);
  const defaultWorkflow = readyWorkflows.find((item) => item.definition.id === project.mediaProject.defaultWorkflowDefinitionId);
  const projectFailure = selectMediaProductionFailure(failures, ["project-update"], project.mediaProject.id);
  const sceneFailure = selectMediaProductionFailure(failures, [
    "scene-create",
    "scene-update",
    "scene-duplicate",
    "scene-reorder",
    "scene-move",
  ]);

  useEffect(() => {
    setName(project.mediaProject.name);
  }, [project.mediaProject.id, project.mediaProject.name]);

  function moveScene(sceneId: string, direction: -1 | 1): void {
    const ids = project.scenes.map((scene) => scene.id);
    const from = ids.indexOf(sceneId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    void actions.reorderScenes(ids);
  }

  const defaultSourceSummary = project.mediaProject.defaultExecutionMode === "workflow"
    ? defaultWorkflow?.definition.name ?? t("Choose a production workflow")
    : defaultProvider?.displayName ?? t("Choose per scene");
  const projectSelectionBusy = busy.projectList;
  const sceneOrderBusy = busy.sceneReorderProjectId === project.mediaProject.id;

  return (
    <aside className="project-scene-outline" aria-label={t("Projects and scenes")}>
      <div className="project-outline-project">
        <div className="project-outline-label">
          <span><FolderCog size={15} /> {t("Project")}</span>
          <span className="project-outline-header-actions">
            <IconButton
              disabled={busy.projectCreate}
              icon={FolderPlus}
              label={t("New project")}
              loading={busy.projectCreate}
              onClick={() => void actions.createProject()}
            />
            <IconButton icon={X} label={t("Close projects and scenes")} onClick={onClose} />
          </span>
        </div>
        <Select
          aria-label={t("Media project")}
          disabled={projectSelectionBusy}
          loading={projectSelectionBusy}
          value={pendingProjectId || selectedProjectId}
          onChange={(event) => actions.selectProject(event.target.value)}
        >
          {projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </Select>
        <Button
          className="project-outline-workflow-entry"
          leadingIcon={<Workflow size={15} />}
          variant="ghost"
          onClick={onOpenWorkflowLibrary}
        >
          <span><strong>{t("Production workflows")}</strong><small>{readyWorkflows.length
            ? t("{count} workflows available", { count: readyWorkflows.length })
            : t("Connect or import a ComfyUI workflow")}</small></span>
        </Button>
        <InspectorSection className="project-outline-settings" title={t("Project settings")} summary={defaultSourceSummary}>
          <div className="project-outline-settings-body">
            <Field className="project-outline-name" error={projectFailure ? t(projectFailure.productMessageKey) : undefined} label={t("Project name")}>
              <Input
                value={name}
                loading={busy.projectUpdateId === project.mediaProject.id}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  const next = name.trim();
                  if (next && next !== project.mediaProject.name) void actions.updateProject({ name: next });
                  else if (!next) setName(project.mediaProject.name);
                }}
              />
            </Field>
            <Field label={t("Default production method")}>
              <Select
                value={project.mediaProject.defaultExecutionMode}
                disabled={busy.projectUpdateId === project.mediaProject.id}
                onChange={(event) => void actions.updateProject({ defaultExecutionMode: event.target.value as "direct" | "workflow" })}
              >
                <option value="direct">{t("Generate directly with a model")}</option>
                <option value="workflow">{t("ComfyUI production workflow")}</option>
              </Select>
            </Field>
            {project.mediaProject.defaultExecutionMode === "direct" ? (
              <Field className="project-outline-model" label={t("Default video model")}>
                {videoProviders.length ? (
                  <Select
                    value={project.mediaProject.defaultProviderPresetId ?? ""}
                    disabled={busy.projectUpdateId === project.mediaProject.id}
                    onChange={(event) => void actions.updateProject({ defaultProviderPresetId: event.target.value || null })}
                  >
                    <option value="">{t("Choose per scene")}</option>
                    {videoProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>)}
                  </Select>
                ) : (
                  <Button className="project-outline-configure" leadingIcon={<Settings2 size={15} />} size="sm" variant="secondary" onClick={onConfigureVideoModel}>
                    {t("Configure video model")}
                  </Button>
                )}
              </Field>
            ) : (
              <Field className="project-outline-model" label={t("Default production workflow")}>
                {readyWorkflows.length ? (
                  <Select
                    value={project.mediaProject.defaultWorkflowDefinitionId ?? ""}
                    disabled={busy.projectUpdateId === project.mediaProject.id}
                    onChange={(event) => void actions.updateProject({ defaultWorkflowDefinitionId: event.target.value || null })}
                  >
                    <option value="">{t("Choose per scene")}</option>
                    {readyWorkflows.map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}
                  </Select>
                ) : (
                  <Button className="project-outline-configure" leadingIcon={<Workflow size={15} />} size="sm" variant="secondary" onClick={onOpenWorkflowLibrary}>
                    {t("Configure production workflow")}
                  </Button>
                )}
              </Field>
            )}
            {projectFailure ? <OwnerFailure failure={projectFailure} actions={actions} /> : null}
            <section className="project-outline-danger" aria-label={t("Danger zone")}>
              <div>
                <strong>{t("Delete project")}</strong>
                <span>{t("Delete {name} and its {count} scenes from this workspace.", { name: project.mediaProject.name, count: project.scenes.length })}</span>
              </div>
              <StatusIndicator compact label={t("Permanent action")} tone="danger" />
              <Button
                leadingIcon={<Trash2 size={15} />}
                size="sm"
                variant="danger"
                disabled={busy.projectUpdateId === project.mediaProject.id}
                onClick={(event) => onRequestProjectDelete(project.mediaProject, event.currentTarget)}
              >
                {t("Delete project")}
              </Button>
            </section>
          </div>
        </InspectorSection>
      </div>

      <div className="project-outline-scenes-head">
        <span><Clapperboard size={15} /> {t("Scenes")} <small>{project.scenes.length}</small></span>
        {project.scenes.length ? (
          <IconButton
            disabled={busy.sceneCreateProjectId === project.mediaProject.id}
            icon={Plus}
            label={t("Add scene")}
            loading={busy.sceneCreateProjectId === project.mediaProject.id}
            onClick={() => void actions.createScene()}
          />
        ) : null}
      </div>
      {sceneFailure ? <OwnerFailure failure={sceneFailure} actions={actions} /> : null}
      <div className="project-outline-scene-list">
        {project.scenes.length ? project.scenes.map((scene, index) => {
          const item = readinessByScene.get(scene.id);
          const sceneBusy = busy.sceneUpdateIds.includes(scene.id)
            || busy.sceneMoveIds.includes(scene.id)
            || busy.sceneDuplicateIds.includes(scene.id)
            || busy.sceneDeleteIds.includes(scene.id);
          return (
            <div className={`project-outline-scene${scene.id === selectedSceneId ? " selected" : ""}`} key={scene.id}>
              <button className="project-outline-scene-main" type="button" onClick={() => onSceneSelect(scene.id)}>
                <span className="project-outline-scene-order">{String(index + 1).padStart(2, "0")}</span>
                <span className="project-outline-scene-copy">
                  <strong>{scene.title}</strong>
                  <StatusIndicator compact label={sceneOutlineStatus(item, t)} tone={sceneOutlineTone(item)} title={item?.reason} />
                </span>
              </button>
              <span className="project-outline-scene-order-actions" aria-label={t("Reorder {name}", { name: scene.title })}>
                <IconButton className="project-outline-sort-button" disabled={sceneOrderBusy || sceneBusy || index === 0} icon={ChevronUp} label={t("Move scene up")} onClick={() => moveScene(scene.id, -1)} />
                <IconButton className="project-outline-sort-button" disabled={sceneOrderBusy || sceneBusy || index === project.scenes.length - 1} icon={ChevronDown} label={t("Move scene down")} onClick={() => moveScene(scene.id, 1)} />
                <IconButton className="project-outline-scene-delete" disabled={sceneBusy} icon={Trash2} label={t("Delete scene")} onClick={(event) => onRequestSceneDelete(scene, event.currentTarget)} />
              </span>
            </div>
          );
        }) : (
          <div className="project-outline-empty">
            <Clapperboard size={20} strokeWidth={1.6} />
            <strong>{t("Start with the first scene")}</strong>
            <span>{t("Add a scene, then define its visual and generation source.")}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function OwnerFailure({ failure, actions }: { readonly failure: MediaProductionFailure; readonly actions: MediaProductionActions }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <InlineFeedback className="project-outline-failure" role="alert" title={t(failure.productMessageKey)} tone="danger">
      <span className="project-outline-failure-actions">
        <Button size="sm" variant="secondary" onClick={() => void actions.retryFailure(failure)}>{t("Retry")}</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.clearFailure(failure.owner, failure.subjectId)}>{t("Clear")}</Button>
      </span>
    </InlineFeedback>
  );
}

function sceneOutlineStatus(readiness: SceneReadiness | undefined, t: (key: string) => string): string {
  if (!readiness) return t("Loading");
  if (readiness.currentArtifact && readiness.latestIssue) return t("Generated · last attempt failed");
  if (readiness.currentArtifact) return readiness.isRegenerating ? t("Generated · updating") : t("Generated · skipped in batch");
  if (readiness.state === "needs_attention") return t("Last attempt incomplete · retry available");
  return t(readiness.label);
}

function sceneOutlineTone(readiness: SceneReadiness | undefined): "neutral" | "success" | "warning" | "info" {
  if (!readiness) return "neutral";
  if (readiness.latestIssue || readiness.state === "needs_attention") return "warning";
  if (readiness.currentArtifact) return "success";
  return readiness.state === "generating" ? "info" : "neutral";
}
