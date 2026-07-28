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

export function SceneInspector(props: SceneInspectorProps): JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<InspectorView>("settings");
  useEffect(() => setView("settings"), [props.scene?.id]);
  if (!props.scene) return <aside className="scene-inspector" />;
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
          <TabsContent value="settings"><SceneSettingsPanel {...props} scene={scene} /></TabsContent>
          <TabsContent value="result"><SceneResultPanel cwd={props.cwd} readiness={props.readiness} artifactsByJob={props.artifactsByJob} /></TabsContent>
          <TabsContent value="history"><SceneRunHistory scene={scene} runs={props.sceneRuns} jobs={props.jobs} artifactsByJob={props.artifactsByJob} actions={props.actions} /></TabsContent>
        </div>
        <SceneRunFooter scene={scene} readiness={props.readiness} busyAction={props.busyAction} actions={props.actions} />
      </aside>
    </Tabs>
  );
}

function SceneSettingsPanel(props: SceneInspectorProps & { readonly scene: MediaScene }): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ title: props.scene.title, prompt: props.scene.prompt });
  const [busy, setBusy] = useState<TextField>();
  const [failure, setFailure] = useState<Partial<Record<TextField, MediaProductionFailure>>>({});
  const targetRef = useRef(props.scene.id);
  const authorityRef = useRef({ id: props.scene.id, title: props.scene.title, prompt: props.scene.prompt });
  useEffect(() => {
    const previous = authorityRef.current;
    targetRef.current = props.scene.id;
    if (previous.id !== props.scene.id) {
      setDraft({ title: props.scene.title, prompt: props.scene.prompt });
      setBusy(undefined);
      setFailure({});
    } else {
      setDraft((current) => ({ title: current.title === previous.title ? props.scene.title : current.title, prompt: current.prompt === previous.prompt ? props.scene.prompt : current.prompt }));
    }
    authorityRef.current = { id: props.scene.id, title: props.scene.title, prompt: props.scene.prompt };
  }, [props.scene.id, props.scene.prompt, props.scene.title]);

  const clear = (field: TextField): void => {
    setFailure((current) => omitField(current, field));
    props.actions.clearFailure("scene-update", props.scene.id);
  };
  const save = async (field: TextField, value: string): Promise<void> => {
    if (busy === field || value === props.scene[field]) return;
    const sceneId = props.scene.id;
    setBusy(field);
    clear(field);
    const outcome = await props.actions.updateScene(sceneId, { [field]: value });
    if (targetRef.current === sceneId) {
      if (!outcome.ok) setFailure((current) => ({ ...current, [field]: outcome.failure }));
      setBusy(undefined);
    }
  };
  const retry = async (field: TextField, item: MediaProductionFailure): Promise<void> => {
    if (busy === field) return;
    const sceneId = props.scene.id;
    setBusy(field);
    const outcome = await props.actions.retryFailure(item);
    if (targetRef.current === sceneId) {
      setFailure((current) => outcome.ok ? omitField(current, field) : { ...current, [field]: outcome.failure });
      setBusy(undefined);
    }
  };
  const revert = (field: TextField, target: HTMLElement): void => {
    setDraft((current) => ({ ...current, [field]: props.scene[field] }));
    clear(field);
    target.blur();
  };

  return <>
    <Field className="field" label={t("Scene {number}", { number: props.scene.sortOrder + 1 })}>
      <Input value={draft.title} disabled={props.sceneUpdateBusy || busy !== undefined} loading={busy === "title"} invalid={Boolean(failure.title)} onChange={(event) => { setDraft((current) => ({ ...current, title: event.target.value })); clear("title"); }} onKeyDown={(event) => { if (event.key === "Escape") revert("title", event.currentTarget); }} onBlur={() => void save("title", draft.title.trim() || props.scene.title)} />
    </Field>
    {failure.title ? <MutationFeedback failure={failure.title} busy={busy === "title"} onRetry={() => void retry("title", failure.title!)} onClear={() => clear("title")} /> : null}
    <Field className="field scene-prompt-field" label={t("Prompt")}>
      <Textarea value={draft.prompt} rows={6} disabled={props.sceneUpdateBusy || busy !== undefined} loading={busy === "prompt"} invalid={Boolean(failure.prompt)} onChange={(event) => { setDraft((current) => ({ ...current, prompt: event.target.value })); clear("prompt"); }} onKeyDown={(event) => { if (event.key === "Escape") revert("prompt", event.currentTarget); }} onBlur={() => void save("prompt", draft.prompt)} />
    </Field>
    {failure.prompt ? <MutationFeedback failure={failure.prompt} busy={busy === "prompt"} onRetry={() => void retry("prompt", failure.prompt!)} onClear={() => clear("prompt")} /> : null}
    <SceneExecutionSettings cwd={props.cwd} scene={props.scene} project={props.project} providers={props.providers} workflows={props.workflows} imageArtifacts={props.imageArtifacts} sceneUpdateBusy={props.sceneUpdateBusy || busy !== undefined} actions={props.actions} onConfigureVideoModel={props.onConfigureVideoModel} onOpenWorkflowLibrary={props.onOpenWorkflowLibrary} />
  </>;
}

function SceneRunFooter({ scene, readiness, busyAction, actions }: { readonly scene: MediaScene; readonly readiness?: SceneReadiness; readonly busyAction: string; readonly actions: MediaProductionActions }): JSX.Element {
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
    const outcome = retry ? await actions.retryFailure(retry) : await actions.runScene(sceneId);
    if (sceneIdRef.current === sceneId && !outcome.ok) setFailure(outcome.failure);
    pendingRef.current = false;
    if (sceneIdRef.current === sceneId) setPending(false);
  };
  const loading = pending || busyAction === `run-scene:${scene.id}`;
  return <div className="scene-inspector-footer">
    {failure ? <MutationFeedback failure={failure} busy={loading} onRetry={() => void run(failure)} onClear={() => { actions.clearFailure(failure.owner, failure.subjectId); setFailure(undefined); }} /> : null}
    <Button leadingIcon={<Play size={16} />} loading={loading} variant="primary" disabled={!readiness?.canRun} onClick={() => void run()}>{readiness?.latestIssue ? t("Retry") : t("Run")}</Button>
  </div>;
}

function MutationFeedback({ failure, busy, onRetry, onClear }: { readonly failure: MediaProductionFailure; readonly busy: boolean; readonly onRetry: () => void; readonly onClear: () => void }): JSX.Element {
  const { t } = useI18n();
  return <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger"><span><Button size="sm" loading={busy} onClick={onRetry}>{t("Retry")}</Button><Button size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button></span>{failure.technicalMessage ? <InspectorSection title={t("Technical details")}><p>{failure.technicalMessage}</p></InspectorSection> : null}</InlineFeedback>;
}

function fallbackReadiness(scene: MediaScene): SceneReadiness { return { sceneId: scene.id, sceneTitle: scene.title, sortOrder: scene.sortOrder, state: "needs_model", status: "needs_model", labelKey: "Not ready", reasonKey: "Not ready", primaryAction: "none", label: "Not ready", reason: "Not ready", isRegenerating: false, latestIssue: false, canRun: false }; }
function statusTone(readiness: SceneReadiness): "neutral" | "info" | "success" | "warning" { if (readiness.currentArtifact) return readiness.latestIssue ? "warning" : "success"; if (readiness.state === "generating") return "info"; return readiness.state === "needs_attention" ? "warning" : "neutral"; }
function omitField<T>(value: T, field: keyof T): T { const next = { ...value }; delete next[field]; return next; }
