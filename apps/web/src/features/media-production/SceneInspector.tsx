import { useEffect, useRef, useState } from "react";
import { Copy, History, Play, Settings2, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, Field, IconButton, InlineFeedback, Input, InspectorSection, StatusIndicator, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "../../shared/ui/index.js";
import type { MediaJob, MediaProject, MediaScene, MediaSceneRun, MediaWorkflowDefinitionDetail, ProviderPreset, RunArtifact } from "../../types.js";
import type { MediaProductionActions, MediaProductionFailure } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";
import { SceneExecutionSettings } from "./SceneExecutionSettings.js";
import { SceneResultPanel } from "./SceneResultPanel.js";
import { SceneRunHistory } from "./SceneRunHistory.js";
import { useSceneTextDraft, type SceneTextDraftController } from "./use-scene-text-draft.js";

type InspectorView = "settings" | "result" | "history";
type TextField = "title" | "prompt";

interface SceneInspectorProps {
  readonly cwd: string;
  readonly scene?: MediaScene;
  readonly project: MediaProject;
  readonly sceneRuns: readonly MediaSceneRun[];
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly imageArtifacts: readonly RunArtifact[];
  readonly readiness?: SceneReadiness;
  readonly busyAction: string;
  readonly sceneUpdateBusy: boolean;
  readonly actions: MediaProductionActions;
  readonly onClose?: () => void;
  readonly onRequestDelete: (scene: MediaScene) => void;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
}

export function SceneInspector(props: SceneInspectorProps): React.JSX.Element {
  if (!props.scene) return <aside className="scene-inspector" />;
  return <SceneInspectorContent key={props.scene.id} {...props} scene={props.scene} />;
}

function SceneInspectorContent(props: SceneInspectorProps & { readonly scene: MediaScene }): React.JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<InspectorView>("settings");
  const editor = useSceneTextDraft(props.scene, props.actions);
  const scene = props.scene;
  const status = props.readiness ?? fallbackReadiness(scene);

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as InspectorView)} asChild>
      <aside className="scene-inspector" aria-label={t("Media production views")} data-scene-id={scene.id}>
        <div className="scene-inspector-head">
          <div><h2>{scene.title}</h2><StatusIndicator compact label={t(status.labelKey, status.labelValues)} tone={statusTone(status)} title={t(status.reasonKey, status.reasonValues)} /></div>
          <div className="scene-inspector-actions">
            {props.onClose ? <IconButton icon={X} label={t("Close")} onClick={props.onClose} /> : null}
            <IconButton icon={Copy} label={t("Duplicate")} loading={props.busyAction === `duplicate-scene:${scene.id}`} onClick={() => void props.actions.duplicateScene(scene.id)} />
            <IconButton icon={Trash2} label={t("Delete")} variant="danger" loading={props.busyAction === `delete-scene:${scene.id}`} onClick={() => props.onRequestDelete(scene)} />
          </div>
        </div>

        <TabsList className="scene-inspector-tabs" aria-label={t("Media production views")}>
          <TabsTrigger className={view === "settings" ? "active" : ""} value="settings"><Settings2 size={14} />{t("Settings")}</TabsTrigger>
          <TabsTrigger className={view === "result" ? "active" : ""} value="result"><Play size={14} />{t("Generated result")}{status.currentArtifact || status.latestIssue ? <span className={`scene-inspector-tab-dot${status.latestIssue ? " attention" : ""}`} aria-hidden="true" /> : null}</TabsTrigger>
          <TabsTrigger className={view === "history" ? "active" : ""} value="history"><History size={14} />{t("History")}{props.sceneRuns.length ? <small>{props.sceneRuns.filter((run) => run.sceneId === scene.id).length}</small> : null}</TabsTrigger>
        </TabsList>

        <div className="scene-inspector-scroll">
          <TabsContent value="settings"><SceneSettingsPanel {...props} scene={scene} editor={editor} /></TabsContent>
          <TabsContent value="result"><SceneResultPanel cwd={props.cwd} readiness={props.readiness} artifactsByJob={props.artifactsByJob} /></TabsContent>
          <TabsContent value="history"><SceneRunHistory scene={scene} runs={props.sceneRuns} jobs={props.jobs} artifactsByJob={props.artifactsByJob} actions={props.actions} /></TabsContent>
        </div>
        <SceneRunFooter scene={scene} readiness={props.readiness} busyAction={props.busyAction} actions={props.actions} editor={editor} />
      </aside>
    </Tabs>
  );
}

function SceneSettingsPanel(props: SceneInspectorProps & { readonly scene: MediaScene; readonly editor: SceneTextDraftController }): React.JSX.Element {
  const { t } = useI18n();
  const { editor } = props;
  const revert = (field: TextField, target: HTMLElement): void => {
    editor.revert(field);
    target.blur();
  };

  return <>
    <Field className="field" label={t("Scene {number}", { number: props.scene.sortOrder + 1 })}>
      <Input value={editor.draft.title} disabled={props.sceneUpdateBusy || editor.busyField !== undefined} loading={editor.busyField === "title"} invalid={Boolean(editor.failures.title)} onChange={(event) => editor.change("title", event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") revert("title", event.currentTarget); }} onBlur={() => void editor.commit("title", editor.draft.title.trim() || props.scene.title)} />
    </Field>
    {editor.failures.title ? <MutationFeedback failure={editor.failures.title} busy={editor.busyField === "title"} onRetry={() => void editor.retry("title", editor.failures.title!)} onClear={() => editor.clear("title")} /> : null}
    <Field className="field scene-prompt-field" label={t("Prompt")} error={editor.promptRequired ? t("Enter a prompt before running.") : undefined}>
      <Textarea ref={editor.promptRef} value={editor.draft.prompt} rows={6} disabled={props.sceneUpdateBusy || editor.busyField !== undefined} loading={editor.busyField === "prompt"} invalid={Boolean(editor.failures.prompt) || editor.promptRequired} onChange={(event) => editor.change("prompt", event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") revert("prompt", event.currentTarget); }} onBlur={() => void editor.commit("prompt")} />
    </Field>
    {editor.failures.prompt ? <MutationFeedback failure={editor.failures.prompt} busy={editor.busyField === "prompt"} onRetry={() => void editor.retry("prompt", editor.failures.prompt!)} onClear={() => editor.clear("prompt")} /> : null}
    <SceneExecutionSettings cwd={props.cwd} scene={props.scene} project={props.project} providers={props.providers} workflows={props.workflows} imageArtifacts={props.imageArtifacts} sceneUpdateBusy={props.sceneUpdateBusy || editor.busyField !== undefined} actions={props.actions} onConfigureVideoModel={props.onConfigureVideoModel} onOpenWorkflowLibrary={props.onOpenWorkflowLibrary} />
  </>;
}

function SceneRunFooter({ scene, readiness, busyAction, actions, editor }: { readonly scene: MediaScene; readonly readiness?: SceneReadiness; readonly busyAction: string; readonly actions: MediaProductionActions; readonly editor: SceneTextDraftController }): React.JSX.Element {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<MediaProductionFailure>();
  const pendingRef = useRef(false);
  const sceneIdRef = useRef(scene.id);
  useEffect(() => { sceneIdRef.current = scene.id; pendingRef.current = false; setPending(false); setFailure(undefined); }, [scene.id]);
  const run = async (retry?: MediaProductionFailure): Promise<void> => {
    if (pendingRef.current) return;
    const sceneId = scene.id;
    pendingRef.current = true;
    setPending(true);
    setFailure(undefined);
    if (!retry && !await editor.commitPromptForRun()) {
      pendingRef.current = false;
      if (sceneIdRef.current === sceneId) setPending(false);
      return;
    }
    const outcome = retry ? await actions.retryFailure(retry) : await actions.runScene(sceneId);
    if (sceneIdRef.current === sceneId && !outcome.ok) setFailure(outcome.failure);
    pendingRef.current = false;
    if (sceneIdRef.current === sceneId) setPending(false);
  };
  const loading = pending || busyAction === `run-scene:${scene.id}`;
  const canRequestRun = Boolean(readiness?.canRun || readiness?.state === "needs_prompt");
  return <div className="scene-inspector-footer">
    {failure ? <MutationFeedback failure={failure} busy={loading} onRetry={() => void run(failure)} onClear={() => { actions.clearFailure(failure.owner, failure.subjectId); setFailure(undefined); }} /> : null}
    <Button leadingIcon={<Play size={16} />} loading={loading} variant="primary" disabled={loading || !canRequestRun} onClick={() => void run()}>{readiness?.latestIssue ? t("Retry") : t("Run")}</Button>
  </div>;
}

function MutationFeedback({ failure, busy, onRetry, onClear }: { readonly failure: MediaProductionFailure; readonly busy: boolean; readonly onRetry: () => void; readonly onClear: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger"><span><Button size="sm" loading={busy} onClick={onRetry}>{t("Retry")}</Button><Button size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button></span>{failure.technicalMessage ? <InspectorSection title={t("Technical details")}><p>{failure.technicalMessage}</p></InspectorSection> : null}</InlineFeedback>;
}

function fallbackReadiness(scene: MediaScene): SceneReadiness { return { sceneId: scene.id, sceneTitle: scene.title, sortOrder: scene.sortOrder, state: "needs_model", status: "needs_model", labelKey: "Not ready", reasonKey: "Not ready", primaryAction: "none", label: "Not ready", reason: "Not ready", isRegenerating: false, latestIssue: false, canRun: false }; }
function statusTone(readiness: SceneReadiness): "neutral" | "info" | "success" | "warning" { if (readiness.currentArtifact) return readiness.latestIssue ? "warning" : "success"; if (readiness.state === "generating") return "info"; return readiness.state === "needs_attention" ? "warning" : "neutral"; }
