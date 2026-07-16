import { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Loader2,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import type {
  ApprovalActionType,
  ApprovalRisk,
  ProviderCapability,
  SkillRevisionPreview,
  ToolName,
} from "../../types.js";
import { SelectControl } from "../../shared/components/SelectControl.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  skillEditorApprovalActionOptions,
  skillEditorProviderCapabilityOptions,
  skillEditorToolOptions,
  type SkillEditorForm,
  type SkillEditorMode,
} from "./skill-editor-utils.js";
import type { SkillEditorBusyState } from "./useSkillEditorController.js";

export function SkillEditorDialog({
  mode,
  sourceKind,
  form,
  dirty,
  busy,
  error,
  conflict,
  preview,
  authorityConfirmation,
  discardConfirmation,
  onFormChange,
  onClose,
  onDiscard,
  onContinueEditing,
  onSave,
  onConfirmAuthorityChanges,
  onReload,
  t,
}: {
  readonly mode: SkillEditorMode;
  readonly sourceKind: "user" | "evolved";
  readonly form: SkillEditorForm;
  readonly dirty: boolean;
  readonly busy: SkillEditorBusyState;
  readonly error: string;
  readonly conflict: boolean;
  readonly preview: SkillRevisionPreview | undefined;
  readonly authorityConfirmation: boolean;
  readonly discardConfirmation: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly onClose: () => void;
  readonly onDiscard: () => void;
  readonly onContinueEditing: () => void;
  readonly onSave: () => void;
  readonly onConfirmAuthorityChanges: () => void;
  readonly onReload: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const formValid = Boolean(form.name.trim() && form.summary.trim() && form.promptFragments.some((item) => item.trim()));
  const saving = busy === "saving";
  const errorRef = useRef<HTMLDivElement>(null);
  const authorityRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [busy, onClose]);

  useEffect(() => {
    const target = authorityConfirmation ? authorityRef.current : error ? errorRef.current : null;
    if (!target) return undefined;
    const frameId = globalThis.requestAnimationFrame(() => target.scrollIntoView({ block: "nearest" }));
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [authorityConfirmation, error]);

  return (
    <div
      className="settings-skill-editor-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="settings-skill-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-skill-editor-title">
        <header className="settings-skill-editor-head">
          <span className="settings-skill-editor-title">
            <Settings2 size={17} />
            <span>
              <strong id="settings-skill-editor-title">{t(mode === "create" ? "Create skill" : "Edit skill")}</strong>
              <small className={sourceKind === "evolved" ? "is-evolved" : undefined}>
                {sourceKind === "evolved" ? <Bot size={12} /> : null}
                {t(sourceKind === "evolved" ? "AI generated" : "My skill")}
              </small>
            </span>
          </span>
          <button className="icon-button" type="button" onClick={onClose} disabled={Boolean(busy)} aria-label={t("Close skill editor")} title={t("Close")}>
            <X size={16} />
          </button>
        </header>

        <div className="settings-skill-editor-body">
          {error ? (
            <div ref={errorRef} className="settings-skill-editor-error" role="alert">
              <strong>{error}</strong>
              {conflict ? (
                <button className="secondary-button compact-button" type="button" onClick={onReload} disabled={Boolean(busy)}>
                  {t("Reload latest version")}
                </button>
              ) : null}
            </div>
          ) : null}

          <section className="settings-skill-editor-section" aria-labelledby="skill-editor-basic-title">
            <header>
              <strong id="skill-editor-basic-title">{t("Basic information")}</strong>
            </header>
            <div className="settings-skill-editor-fields">
              <label className="field">
                <span>{t("Skill name")}</span>
                <input
                  autoFocus
                  value={form.name}
                  onChange={(event) => onFormChange({ ...form, name: event.currentTarget.value })}
                  disabled={Boolean(busy)}
                  maxLength={160}
                />
              </label>
              <label className="field">
                <span>{t("Skill description")}</span>
                <textarea
                  rows={3}
                  value={form.summary}
                  onChange={(event) => onFormChange({ ...form, summary: event.currentTarget.value })}
                  disabled={Boolean(busy)}
                />
              </label>
            </div>
          </section>

          <section className="settings-skill-editor-section" aria-labelledby="skill-editor-instructions-title">
            <header className="settings-skill-editor-section-head">
              <strong id="skill-editor-instructions-title">{t("Execution instructions")}</strong>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onFormChange({ ...form, promptFragments: [...form.promptFragments, ""] })}
                disabled={Boolean(busy)}
              >
                <Plus size={14} />
                {t("Add instruction")}
              </button>
            </header>
            <div className="settings-skill-instruction-list">
              {form.promptFragments.map((fragment, index) => (
                <article className="settings-skill-instruction-row" key={index}>
                  <div className="settings-skill-instruction-order" aria-label={t("Instruction order")}>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onFormChange({ ...form, promptFragments: moveItem(form.promptFragments, index, index - 1) })}
                      disabled={Boolean(busy) || index === 0}
                      aria-label={t("Move instruction up")}
                      title={t("Move up")}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onFormChange({ ...form, promptFragments: moveItem(form.promptFragments, index, index + 1) })}
                      disabled={Boolean(busy) || index === form.promptFragments.length - 1}
                      aria-label={t("Move instruction down")}
                      title={t("Move down")}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </div>
                  <label className="field">
                    <span>{t("Instruction {index}", { index: index + 1 })}</span>
                    <textarea
                      rows={5}
                      value={fragment}
                      onChange={(event) => onFormChange({
                        ...form,
                        promptFragments: replaceItem(form.promptFragments, index, event.currentTarget.value),
                      })}
                      disabled={Boolean(busy)}
                    />
                  </label>
                  <button
                    className="icon-button danger"
                    type="button"
                    onClick={() => onFormChange({
                      ...form,
                      promptFragments: form.promptFragments.length === 1 ? [""] : form.promptFragments.filter((_, itemIndex) => itemIndex !== index),
                    })}
                    disabled={Boolean(busy)}
                    aria-label={t("Remove instruction")}
                    title={t("Remove")}
                  >
                    <Trash2 size={14} />
                  </button>
                </article>
              ))}
            </div>
          </section>

          <details className="settings-skill-editor-advanced">
            <summary>
              <span><ChevronRight size={15} />{t("Advanced configuration")}</span>
              <small>{t("Tools, model capabilities, and approvals")}</small>
            </summary>
            <div className="settings-skill-editor-advanced-body">
              <OptionChecklist
                title={t("Required tools")}
                values={skillEditorToolOptions}
                selected={form.requiredTools}
                disabled={Boolean(busy)}
                label={(value) => t(toolLabel(value))}
                onToggle={(value) => onFormChange({ ...form, requiredTools: toggleValue(form.requiredTools, value) })}
              />
              <OptionChecklist
                title={t("Model capabilities")}
                values={skillEditorProviderCapabilityOptions}
                selected={form.requiredProviderCapabilities}
                disabled={Boolean(busy)}
                label={(value) => t(providerCapabilityLabel(value))}
                onToggle={(value) => onFormChange({
                  ...form,
                  requiredProviderCapabilities: toggleValue(form.requiredProviderCapabilities, value),
                })}
              />
              <ApprovalEditor form={form} busy={Boolean(busy)} onFormChange={onFormChange} t={t} />
            </div>
          </details>

          {preview?.warnings.length ? (
            <details className="settings-skill-editor-review-notes">
              <summary>{t("Things to review")}</summary>
              <ul>{preview.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{t(warningLabel(warning.code))}</li>)}</ul>
            </details>
          ) : null}

          {authorityConfirmation && preview ? (
            <section ref={authorityRef} className="settings-skill-authority-confirmation" role="alert" aria-label={t("Runtime requirement changes")}>
              <strong>{t("Runtime requirements changed")}</strong>
              <p>{t("Review these changes before saving. Existing bindings stay unchanged.")}</p>
              <div>
                {preview.authorityDiff.requiredToolsChanged ? (
                  <span>
                    <strong>{t("Required tools changed")}</strong>
                    <small>{authorityListDiffText(preview.authorityDiff.before.requiredTools, preview.authorityDiff.after.requiredTools, (value) => t(toolLabel(value)), t)}</small>
                  </span>
                ) : null}
                {preview.authorityDiff.requiredProviderCapabilitiesChanged ? (
                  <span>
                    <strong>{t("Model capabilities changed")}</strong>
                    <small>{authorityListDiffText(
                      preview.authorityDiff.before.requiredProviderCapabilities,
                      preview.authorityDiff.after.requiredProviderCapabilities,
                      (value) => t(providerCapabilityLabel(value)),
                      t,
                    )}</small>
                  </span>
                ) : null}
                {preview.authorityDiff.approvalProfileChanged ? (
                  <span>
                    <strong>{t("Approval policy changed")}</strong>
                    <small>{t("From {before} to {after}", {
                      before: approvalProfileSummary(preview.authorityDiff.before.approvalProfile, t),
                      after: approvalProfileSummary(preview.authorityDiff.after.approvalProfile, t),
                    })}</small>
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="settings-skill-editor-actions">
          {discardConfirmation ? (
            <div className="settings-skill-editor-discard" role="alert">
              <strong>{t("Discard unsaved changes?")}</strong>
              <span>
                <button className="secondary-button compact-button" type="button" onClick={onContinueEditing}>{t("Continue editing")}</button>
                <button className="secondary-button danger compact-button" type="button" onClick={onDiscard}>{t("Discard changes")}</button>
              </span>
            </div>
          ) : (
            <>
              <button className="secondary-button compact-button" type="button" onClick={onClose} disabled={Boolean(busy)}>{t("Cancel")}</button>
              <button
                className="primary-button compact-button"
                type="button"
                onClick={authorityConfirmation ? onConfirmAuthorityChanges : onSave}
                disabled={Boolean(busy) || !formValid || (mode === "revision" && !dirty && !authorityConfirmation)}
              >
                {busy ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                {t(busy === "checking" ? "Checking..." : busy === "saving" ? "Saving..." : authorityConfirmation ? "Confirm and save" : "Save changes")}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function ApprovalEditor({
  form,
  busy,
  onFormChange,
  t,
}: {
  readonly form: SkillEditorForm;
  readonly busy: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return (
    <section className="settings-skill-editor-option-section">
      <strong>{t("Approval policy")}</strong>
      <div className="settings-skill-approval-mode" role="group" aria-label={t("Approval mode")}>
        {(["none", "standard", "strict"] as const).map((mode) => (
          <button
            key={mode}
            className={form.approvalMode === mode ? "active" : undefined}
            type="button"
            onClick={() => onFormChange({
              ...form,
              approvalMode: mode,
              ...(mode === "none" ? {
                approvalRisk: "",
                approvalRequiredForTools: [],
                approvalRequiredForActions: [],
              } : {}),
            })}
            disabled={busy}
          >
            {t(approvalModeLabel(mode))}
          </button>
        ))}
      </div>
      {form.approvalMode !== "none" ? (
        <div className="settings-skill-approval-details">
          <label className="field">
            <span>{t("Risk level")}</span>
            <SelectControl
              value={form.approvalRisk}
              onChange={(event) => onFormChange({ ...form, approvalRisk: event.currentTarget.value as ApprovalRisk | "" })}
              disabled={busy}
            >
              <option value="">{t("Use action risk")}</option>
              <option value="low">{t("Low")}</option>
              <option value="medium">{t("Medium")}</option>
              <option value="high">{t("High")}</option>
              <option value="critical">{t("Critical")}</option>
            </SelectControl>
          </label>
          <OptionChecklist
            title={t("Tools that require approval")}
            values={skillEditorToolOptions}
            selected={form.approvalRequiredForTools}
            disabled={busy}
            label={(value) => t(toolLabel(value))}
            onToggle={(value) => onFormChange({
              ...form,
              approvalRequiredForTools: toggleValue(form.approvalRequiredForTools, value),
            })}
          />
          <OptionChecklist
            title={t("Actions that require approval")}
            values={skillEditorApprovalActionOptions}
            selected={form.approvalRequiredForActions}
            disabled={busy}
            label={(value) => t(approvalActionLabel(value))}
            onToggle={(value) => onFormChange({
              ...form,
              approvalRequiredForActions: toggleValue(form.approvalRequiredForActions, value),
            })}
          />
        </div>
      ) : null}
    </section>
  );
}

function OptionChecklist<T extends string>({
  title,
  values,
  selected,
  disabled,
  label,
  onToggle,
}: {
  readonly title: string;
  readonly values: readonly T[];
  readonly selected: readonly T[];
  readonly disabled: boolean;
  readonly label: (value: T) => string;
  readonly onToggle: (value: T) => void;
}): JSX.Element {
  return (
    <section className="settings-skill-editor-option-section">
      <strong>{title}</strong>
      <div className="settings-skill-editor-options">
        {values.map((value) => (
          <label key={value}>
            <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} disabled={disabled} />
            <span>{label(value)}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function replaceItem(values: readonly string[], index: number, value: string): string[] {
  return values.map((item, itemIndex) => itemIndex === index ? value : item);
}

function moveItem(values: readonly string[], from: number, to: number): string[] {
  if (to < 0 || to >= values.length) return [...values];
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function authorityListDiffText<T extends string>(
  before: readonly T[],
  after: readonly T[],
  label: (value: T) => string,
  t: SettingsTranslator,
): string {
  const added = after.filter((value) => !before.includes(value)).map(label);
  const removed = before.filter((value) => !after.includes(value)).map(label);
  return [
    ...(added.length > 0 ? [t("Added: {items}", { items: added.join(", ") })] : []),
    ...(removed.length > 0 ? [t("Removed: {items}", { items: removed.join(", ") })] : []),
  ].join("; ");
}

function approvalProfileSummary(profile: SkillRevisionPreview["authorityDiff"]["before"]["approvalProfile"], t: SettingsTranslator): string {
  const parts = [t(approvalModeLabel(profile.mode))];
  if (profile.risk) parts.push(t(approvalRiskLabel(profile.risk)));
  if (profile.requiredForTools?.length) parts.push(t("{count} approval tools", { count: profile.requiredForTools.length }));
  if (profile.requiredForActions?.length) parts.push(t("{count} approval actions", { count: profile.requiredForActions.length }));
  return parts.join(" / ");
}

function toolLabel(value: ToolName): string {
  const labels: Record<ToolName, string> = {
    read: "Read files",
    grep: "Search file contents",
    find: "Find files",
    ls: "List folders",
    bash: "Run commands",
    edit: "Edit files",
    write: "Create files",
  };
  return labels[value];
}

function providerCapabilityLabel(value: ProviderCapability): string {
  const labels: Record<ProviderCapability, string> = {
    chat: "Chat",
    tool_call: "Tool calling",
    reasoning: "Reasoning",
    vision: "Image understanding",
    web_search: "Web search",
    embedding: "Embeddings",
    image_generate: "Image generation",
    image_edit: "Image editing",
    video_generate: "Video generation",
    tts: "Text to speech",
    asr: "Speech recognition",
  };
  return labels[value];
}

function approvalModeLabel(value: SkillEditorForm["approvalMode"]): string {
  if (value === "standard") return "Standard approval";
  if (value === "strict") return "Strict approval";
  return "No extra approval";
}

function approvalRiskLabel(value: ApprovalRisk): string {
  if (value === "low") return "Low";
  if (value === "medium") return "Medium";
  if (value === "high") return "High";
  return "Critical";
}

function approvalActionLabel(value: ApprovalActionType): string {
  const labels: Record<ApprovalActionType, string> = {
    read: "Read files",
    grep: "Search file contents",
    find: "Find files",
    ls: "List folders",
    write: "Create files",
    edit: "Edit files",
    bash: "Run commands",
    git_commit: "Create Git commits",
    git_push: "Push Git changes",
    external_send: "Send externally",
    deploy: "Deploy",
    media_cost: "Paid media generation",
    credential_change: "Change credentials",
    provider_change: "Change model provider",
    workflow_step: "Run workflow steps",
    mcp_tool_call: "Call MCP tools",
    runtime_permission_request: "Request runtime permissions",
  };
  return labels[value];
}

function warningLabel(code: SkillRevisionPreview["warnings"][number]["code"]): string {
  if (code === "permission_like_instruction") return "The instructions mention permissions. Ling still enforces the configured approval policy.";
  if (code === "secret_reference") return "The instructions mention credentials. Secrets must be configured separately.";
  if (code === "external_send_claim") return "The instructions mention external actions. Those actions still require approval.";
  if (code === "unknown_tool") return "A required tool is not supported.";
  if (code === "unknown_provider_capability") return "A required model capability is not supported.";
  if (code === "duplicate_skill_id") return "A skill with the same identity already exists.";
  if (code === "unsupported_section") return "Some content cannot be represented by this editor.";
  return "Required skill information is missing.";
}
