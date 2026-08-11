import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Settings2, Workflow } from "lucide-react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { artifactContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Button, Checkbox, Field, InlineFeedback, Input, InspectorSection, Select, Textarea } from "../../shared/ui/index.js";
import type { MediaProject, MediaScene, MediaWorkflowInputField, MediaWorkflowDefinitionDetail, ProviderPreset, RunArtifact } from "../../types.js";
import type { MediaProductionActions, MediaProductionFailure, MediaScenePatch } from "./media-production-types.js";
import { deriveSceneSourceProjection, workflowFieldSceneValue } from "./media-production-view-models.js";
type SettingsField = "executionMode" | "provider" | "workflow" | "ratio" | "duration" | "references" | `workflow:${string}`;
interface ExecutionDraft {
  readonly executionMode: MediaScene["executionMode"];
  readonly providerPresetId: string;
  readonly workflowDefinitionId: string;
  readonly ratio: string;
  readonly durationSeconds: number;
  readonly referenceArtifactIds: readonly string[];
  readonly workflowInputValues: Readonly<Record<string, unknown>>;
}
export function SceneExecutionSettings({
  cwd,
  scene,
  project,
  providers,
  workflows,
  imageArtifacts,
  sceneUpdateBusy,
  actions,
  onConfigureVideoModel,
  onOpenWorkflowLibrary,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly sceneUpdateBusy: boolean;
  readonly actions: MediaProductionActions;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ExecutionDraft>(() => sceneDraft(scene));
  const [busyFields, setBusyFields] = useState<ReadonlySet<SettingsField>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Partial<Record<SettingsField, MediaProductionFailure>>>>({});
  const sceneIdRef = useRef(scene.id);

  useEffect(() => {
    sceneIdRef.current = scene.id;
    setDraft(sceneDraft(scene));
    setBusyFields(new Set());
    setFailures({});
  }, [scene.id]);

  const draftScene = useMemo<MediaScene>(() => ({
    ...scene,
    ...draft,
    providerPresetId: draft.providerPresetId || undefined,
    workflowDefinitionId: draft.workflowDefinitionId || undefined,
    workflowInputValues: { ...draft.workflowInputValues },
  }), [draft, scene]);
  const source = useMemo(() => deriveSceneSourceProjection({ scene: draftScene, project, providers, workflows }), [draftScene, project, providers, workflows]);

  const clearFailure = (field: SettingsField): void => {
    setFailures((current) => omitFailure(current, field));
    actions.clearFailure("scene-update", scene.id);
  };
  const save = async (field: SettingsField, patch: MediaScenePatch): Promise<void> => {
    if (busyFields.has(field)) return;
    const targetSceneId = scene.id;
    setBusyFields((current) => addField(current, field));
    clearFailure(field);
    const outcome = await actions.updateScene(targetSceneId, patch);
    if (sceneIdRef.current === targetSceneId && !outcome.ok) setFailures((current) => ({ ...current, [field]: outcome.failure }));
    if (sceneIdRef.current === targetSceneId) setBusyFields((current) => removeField(current, field));
  };
  const retry = async (field: SettingsField, failure: MediaProductionFailure): Promise<void> => {
    if (busyFields.has(field)) return;
    const targetSceneId = scene.id;
    setBusyFields((current) => addField(current, field));
    const outcome = await actions.retryFailure(failure);
    if (sceneIdRef.current === targetSceneId) {
      setFailures((current) => outcome.ok ? omitFailure(current, field) : { ...current, [field]: outcome.failure });
      setBusyFields((current) => removeField(current, field));
    }
  };
  const updateDraft = <Key extends keyof ExecutionDraft>(key: Key, value: ExecutionDraft[Key], field: SettingsField): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearFailure(field);
  };
  const feedback = (field: SettingsField) => failures[field] ? (
    <FieldFailure
      failure={failures[field]}
      busy={busyFields.has(field)}
      onClear={() => clearFailure(field)}
      onRetry={() => void retry(field, failures[field]!)}
    />
  ) : null;

  return (
    <section className="scene-inspector-section scene-execution-settings" data-scene-source={source.mode}>
      <span className="field-label">{t("Project settings")}</span>
      <Field className="field" label={t("Default production method")}>
        <Select
          value={draft.executionMode}
          disabled={sceneUpdateBusy}
          loading={busyFields.has("executionMode")}
          invalid={Boolean(failures.executionMode)}
          onChange={(event) => {
            const executionMode = event.target.value as MediaScene["executionMode"];
            updateDraft("executionMode", executionMode, "executionMode");
            void save("executionMode", { executionMode });
          }}
        >
          <option value="inherit">{t("Default")}</option>
          <option value="direct">{t("Generate directly with a model")}</option>
          <option value="workflow">{t("ComfyUI production workflow")}</option>
        </Select>
      </Field>
      {feedback("executionMode")}

      {source.mode === "workflow" ? (
        <WorkflowSettings
          draft={draft}
          scene={draftScene}
          authorityScene={scene}
          source={source}
          imageArtifacts={imageArtifacts}
          busyFields={busyFields}
          sceneUpdateBusy={sceneUpdateBusy}
          failures={failures}
          updateDraft={updateDraft}
          save={save}
          feedback={feedback}
          onRepair={onOpenWorkflowLibrary}
        />
      ) : (
        <DirectSettings
          cwd={cwd}
          draft={draft}
          scene={draftScene}
          authorityScene={scene}
          source={source}
          imageArtifacts={imageArtifacts}
          busyFields={busyFields}
          sceneUpdateBusy={sceneUpdateBusy}
          failures={failures}
          updateDraft={updateDraft}
          save={save}
          feedback={feedback}
          onRepair={onConfigureVideoModel}
        />
      )}
    </section>
  );
}

function DirectSettings(input: SettingsBranchProps & { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const capability = !input.source.blocker && input.source.selectedProvider
    ? resolveMediaProviderRuntimeState(input.source.selectedProvider, "video_generate").videoGeneration
    : undefined;
  return <>
    <Field className="field" label={t("Default video model")}>
      <Select value={input.draft.providerPresetId} disabled={input.sceneUpdateBusy} loading={input.busyFields.has("provider")} invalid={Boolean(input.failures.provider)} onChange={(event) => {
        const providerPresetId = event.target.value;
        input.updateDraft("providerPresetId", providerPresetId, "provider");
        void input.save("provider", { providerPresetId: providerPresetId || null });
      }}>
        <option value="">{t("Default")}</option>
        {input.source.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>)}
        {input.source.providerId && !input.source.providers.some((provider) => provider.id === input.source.providerId)
          ? <option value={input.source.providerId} disabled>{input.source.selectedProvider?.displayName ?? t("Not ready")}</option> : null}
      </Select>
    </Field>
    {input.feedback("provider")}
    {input.source.blocker ? <SourceRepair actionLabel={t("Configure video model")} label={t(input.source.blocker.key)} icon={<Settings2 size={15} />} onClick={input.onRepair} /> : null}
    {capability ? <>
      <div className="scene-parameter-grid">
        <Field className="field" label={t("Aspect ratio")}>
          <Select value={input.draft.ratio} disabled={input.sceneUpdateBusy} loading={input.busyFields.has("ratio")} invalid={Boolean(input.failures.ratio)} onChange={(event) => {
            const ratio = event.target.value;
            input.updateDraft("ratio", ratio, "ratio");
            void input.save("ratio", { ratio });
          }}>{(capability.aspectRatios ?? [input.draft.ratio]).map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}</Select>
        </Field>
        <Field className="field" label={t("Video duration")}>
          <Select value={String(input.draft.durationSeconds)} disabled={input.sceneUpdateBusy} loading={input.busyFields.has("duration")} invalid={Boolean(input.failures.duration)} onChange={(event) => {
            const durationSeconds = Number(event.target.value);
            input.updateDraft("durationSeconds", durationSeconds, "duration");
            void input.save("duration", { durationSeconds });
          }}>{(capability.durationsSeconds ?? [input.draft.durationSeconds]).map((duration) => <option key={duration} value={duration}>{t("{count} seconds", { count: duration })}</option>)}</Select>
        </Field>
      </div>
      {input.feedback("ratio")}{input.feedback("duration")}
      {capability.inputModes.includes("image_reference") ? <ReferenceAssets {...input} /> : null}
    </> : null}
  </>;
}

function WorkflowSettings(input: SettingsBranchProps): React.JSX.Element {
  const { t } = useI18n();
  const fields = input.source.blocker ? [] : input.source.selectedWorkflow?.currentVersion?.inputFields.filter((field) => field.semantic !== "prompt") ?? [];
  return <>
    <Field className="field" label={t("Default production workflow")}>
      <Select value={input.draft.workflowDefinitionId} disabled={input.sceneUpdateBusy} loading={input.busyFields.has("workflow")} invalid={Boolean(input.failures.workflow)} onChange={(event) => {
        const workflowDefinitionId = event.target.value;
        input.updateDraft("workflowDefinitionId", workflowDefinitionId, "workflow");
        void input.save("workflow", { workflowDefinitionId: workflowDefinitionId || null });
      }}>
        <option value="">{t("Default")}</option>
        {input.source.workflows.map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}
        {input.source.workflowId && !input.source.workflows.some((item) => item.definition.id === input.source.workflowId)
          ? <option value={input.source.workflowId} disabled>{input.source.selectedWorkflow?.definition.name ?? t("Not ready")}</option> : null}
      </Select>
    </Field>
    {input.feedback("workflow")}
    {input.source.blocker ? <SourceRepair actionLabel={t("Configure production workflow")} label={t(input.source.blocker.key)} icon={<Workflow size={15} />} onClick={input.onRepair} /> : null}
    {fields.map((field) => <WorkflowField key={field.id} field={field} input={input} />)}
  </>;
}

function WorkflowField({ field, input }: { readonly field: MediaWorkflowInputField; readonly input: SettingsBranchProps }): React.JSX.Element {
  const { t } = useI18n();
  const fieldKey = `workflow:${field.id}` as const;
  const value = workflowFieldSceneValue(field, input.scene);
  const invalid = Boolean(input.failures[fieldKey]) || (field.required && (value === "" || value === null || value === undefined));
  const saveValue = (next: unknown): void => {
    if (Object.is(next, workflowFieldSceneValue(field, input.authorityScene))) return;
    input.updateDraft("workflowInputValues", { ...input.draft.workflowInputValues, [field.id]: next }, fieldKey);
    void input.save(fieldKey, workflowFieldPatch(field, next, input.authorityScene));
  };
  const common = { disabled: input.sceneUpdateBusy, loading: input.busyFields.has(fieldKey), invalid };
  return <div className="scene-workflow-field">
    {field.kind === "boolean" ? <Checkbox checked={Boolean(value)} loading={common.loading} label={field.label} onChange={(event) => saveValue(event.target.checked)} />
      : <Field className="field" label={field.label} required={field.required} error={invalid && !input.failures[fieldKey] ? t("Not ready") : undefined}>
        {field.kind === "select" ? <Select {...common} value={String(value ?? "")} onChange={(event) => saveValue(event.target.value)}>{(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}</Select>
          : field.kind === "image_artifact" ? <Select {...common} value={String(value ?? "")} onChange={(event) => saveValue(event.target.value)}><option value="">{t("Default")}</option>{input.imageArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title ?? t("Generated result")}</option>)}</Select>
            : field.kind === "number" ? <Input {...common} type="number" value={String(value ?? "")} onChange={(event) => input.updateDraft("workflowInputValues", { ...input.draft.workflowInputValues, [field.id]: event.target.value }, fieldKey)} onBlur={(event) => saveValue(Number(event.target.value))} />
              : <Textarea {...common} rows={3} value={String(value ?? "")} onChange={(event) => input.updateDraft("workflowInputValues", { ...input.draft.workflowInputValues, [field.id]: event.target.value }, fieldKey)} onBlur={(event) => saveValue(event.target.value)} />}
      </Field>}
    {input.feedback(fieldKey)}
  </div>;
}

function ReferenceAssets(input: SettingsBranchProps & { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  return <div className="reference-asset-picker compact">
    <div className="scene-inspector-section-head"><span className="field-label">{t("References")}</span><small>{t("Current workspace")}</small></div>
    {input.imageArtifacts.length ? <div className="reference-asset-grid">{input.imageArtifacts.map((artifact) => {
      const selected = input.draft.referenceArtifactIds.includes(artifact.id);
      return <div className={`reference-asset${selected ? " selected" : ""}`} key={artifact.id}>
        <img src={artifactContentUrl(artifact.id, input.cwd)} alt="" />
        <Checkbox checked={selected} disabled={input.sceneUpdateBusy} loading={input.busyFields.has("references")} label={artifact.title ?? t("Generated result")} onChange={() => {
          const referenceArtifactIds = selected ? input.draft.referenceArtifactIds.filter((id) => id !== artifact.id) : [...input.draft.referenceArtifactIds, artifact.id];
          input.updateDraft("referenceArtifactIds", referenceArtifactIds, "references");
          void input.save("references", { referenceArtifactIds });
        }} />
      </div>;
    })}</div> : <p className="scene-inspector-hint"><ImageIcon size={14} />{t("No artifacts")}</p>}
    {input.feedback("references")}
  </div>;
}

interface SettingsBranchProps {
  readonly draft: ExecutionDraft;
  readonly scene: MediaScene;
  readonly authorityScene: MediaScene;
  readonly source: ReturnType<typeof deriveSceneSourceProjection>;
  readonly imageArtifacts: readonly RunArtifact[];
  readonly busyFields: ReadonlySet<SettingsField>;
  readonly sceneUpdateBusy: boolean;
  readonly failures: Readonly<Partial<Record<SettingsField, MediaProductionFailure>>>;
  readonly updateDraft: <Key extends keyof ExecutionDraft>(key: Key, value: ExecutionDraft[Key], field: SettingsField) => void;
  readonly save: (field: SettingsField, patch: MediaScenePatch) => Promise<void>;
  readonly feedback: (field: SettingsField) => React.JSX.Element | null;
  readonly onRepair: () => void;
}

function SourceRepair({ actionLabel, label, icon, onClick }: { readonly actionLabel: string; readonly label: string; readonly icon: React.JSX.Element; readonly onClick: () => void }): React.JSX.Element {
  return <InlineFeedback title={label} tone="warning"><Button leadingIcon={icon} size="sm" variant="secondary" onClick={onClick}>{actionLabel}</Button></InlineFeedback>;
}

function FieldFailure({ failure, busy, onRetry, onClear }: { readonly failure: MediaProductionFailure; readonly busy: boolean; readonly onRetry: () => void; readonly onClear: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger">
    <span className="scene-field-failure-actions"><Button size="sm" loading={busy} variant="secondary" onClick={onRetry}>{t("Retry")}</Button><Button size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button></span>
    {failure.technicalMessage ? <InspectorSection title={t("Technical details")}><p>{failure.technicalMessage}</p></InspectorSection> : null}
  </InlineFeedback>;
}

function sceneDraft(scene: MediaScene): ExecutionDraft {
  return { executionMode: scene.executionMode, providerPresetId: scene.providerPresetId ?? "", workflowDefinitionId: scene.workflowDefinitionId ?? "", ratio: scene.ratio, durationSeconds: scene.durationSeconds, referenceArtifactIds: [...scene.referenceArtifactIds], workflowInputValues: { ...scene.workflowInputValues } };
}

function workflowFieldPatch(field: MediaWorkflowInputField, value: unknown, scene: MediaScene): MediaScenePatch {
  if (field.semantic === "ratio") return { ratio: String(value) };
  if (field.semantic === "duration") return { durationSeconds: Number(value) };
  if (field.semantic === "reference_image") return { referenceArtifactIds: value ? [String(value)] : [] };
  return { workflowInputValues: { ...scene.workflowInputValues, [field.id]: value } };
}

function addField(fields: ReadonlySet<SettingsField>, field: SettingsField): ReadonlySet<SettingsField> { return new Set([...fields, field]); }
function removeField(fields: ReadonlySet<SettingsField>, field: SettingsField): ReadonlySet<SettingsField> { const next = new Set(fields); next.delete(field); return next; }
function omitFailure(failures: Readonly<Partial<Record<SettingsField, MediaProductionFailure>>>, field: SettingsField): Readonly<Partial<Record<SettingsField, MediaProductionFailure>>> { const next = { ...failures }; delete next[field]; return next; }
