import { Check, ChevronDown, Loader2, Plus, Save, X } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n.js";
import { approvalPolicyToForm, defaultApprovalPolicyForm } from "../../lib/approvals.js";
import { Input } from "../../shared/ui/index.js";
import type { ApprovalPolicy, ApprovalPolicyFormState, ApprovalToolDecision, ToolName } from "../../types.js";
import {
  addAllowedWritePath,
  applyPermissionGroupDecision,
  applyPermissionToolDecision,
  approvalPolicyFormsEqual,
  parseAllowedWritePaths,
  permissionGroupDecision,
  permissionToolGroups,
  permissionToolLabelKeys,
  removeAllowedWritePath,
  type PermissionGroupDecision,
  type PermissionToolGroup,
  type PermissionToolGroupId,
} from "./permission-policy-view-model.js";

const permissionDecisionOptions: readonly ApprovalToolDecision[] = ["allow", "ask", "deny"];

export function AdvancedWorkspacePolicyEditor({
  policy,
  form,
  isLoading,
  onFormChange,
  onSave,
}: {
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly isLoading: boolean;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onSave: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [expandedGroupIds, setExpandedGroupIds] = useState<readonly PermissionToolGroupId[]>([]);
  const [isAddingPath, setIsAddingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const baselineForm = policy ? approvalPolicyToForm(policy) : defaultApprovalPolicyForm;
  const isDirty = !approvalPolicyFormsEqual(form, baselineForm);
  const writePaths = parseAllowedWritePaths(form.allowedWritePathsText);

  function commitForm(nextForm: ApprovalPolicyFormState): void {
    if (!approvalPolicyFormsEqual(form, nextForm)) {
      onFormChange(nextForm);
    }
  }

  function toggleGroup(groupId: PermissionToolGroupId): void {
    setExpandedGroupIds((current) => (
      current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId]
    ));
  }

  function submitPath(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    const normalizedPath = pathDraft.trim();
    if (!normalizedPath) {
      return;
    }
    commitForm(addAllowedWritePath(form, normalizedPath));
    setPathDraft("");
    setIsAddingPath(false);
  }

  function cancelPath(): void {
    setPathDraft("");
    setIsAddingPath(false);
  }

  function handlePathKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelPath();
    }
  }

  return (
    <div className="settings-advanced-policy-editor">
      <div className="settings-permission-group-list">
        {permissionToolGroups.map((group) => {
          const expanded = expandedGroupIds.includes(group.id);
          const decision = permissionGroupDecision(form, group);
          const groupLabel = t(group.labelKey);
          return (
            <section className="settings-permission-group" key={group.id} aria-labelledby={`permission-group-${group.id}`}>
              <div className="settings-permission-group-row">
                <div className="settings-permission-group-copy">
                  <strong id={`permission-group-${group.id}`}>{groupLabel}</strong>
                  <small>{group.tools.join(", ")}</small>
                </div>
                <div className="settings-permission-group-actions">
                  {decision === "mixed" ? <span className="settings-permission-mixed">{t("Custom")}</span> : null}
                  <PermissionDecisionControl
                    label={groupLabel}
                    value={decision}
                    onChange={(nextDecision) => commitForm(applyPermissionGroupDecision(form, group, nextDecision))}
                  />
                  <button
                    className="settings-permission-customize-button"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`permission-group-tools-${group.id}`}
                    onClick={() => toggleGroup(group.id)}
                  >
                    {t("Customize")}
                    <ChevronDown className={expanded ? "expanded" : ""} size={14} />
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="settings-permission-tool-list" id={`permission-group-tools-${group.id}`}>
                  {group.tools.map((tool) => (
                    <PermissionToolRow
                      key={tool}
                      tool={tool}
                      group={group}
                      value={form.toolDecisions[tool]}
                      onChange={(nextDecision) => commitForm(applyPermissionToolDecision(form, tool, nextDecision))}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <section className="settings-write-path-editor" aria-labelledby="settings-write-path-title">
        <div className="settings-write-path-header">
          <strong id="settings-write-path-title">{t("Write access")}</strong>
          {!isAddingPath ? (
            <button className="secondary-button compact-button" type="button" onClick={() => setIsAddingPath(true)}>
              <Plus size={14} />
              {t("Add path")}
            </button>
          ) : null}
        </div>

        {writePaths.length > 0 ? (
          <ul className="settings-write-path-list">
            {writePaths.map((path) => {
              const pathLabel = path === "." ? t("Current workspace") : path;
              return (
                <li key={path}>
                  <span title={path}>{pathLabel}</span>
                  <button
                    className="ghost-icon-button compact-icon-button"
                    type="button"
                    aria-label={t("Remove path {path}", { path: pathLabel })}
                    title={t("Remove path {path}", { path: pathLabel })}
                    onClick={() => commitForm(removeAllowedWritePath(form, path))}
                  >
                    <X size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="settings-write-path-empty">{t("No write paths allowed")}</p>
        )}

        {isAddingPath ? (
          <form className="settings-write-path-add" onSubmit={submitPath}>
            <Input
              autoFocus
              containerClassName="settings-write-path-control"
              value={pathDraft}
              aria-label={t("Write path")}
              placeholder={t("Enter a workspace-relative or absolute path")}
              onChange={(event) => setPathDraft(event.target.value)}
              onKeyDown={handlePathKeyDown}
            />
            <button className="secondary-button compact-button" type="submit" disabled={!pathDraft.trim()}>
              {t("Add")}
            </button>
            <button className="ghost-button compact-button" type="button" onClick={cancelPath}>
              {t("Cancel")}
            </button>
          </form>
        ) : null}
      </section>

      <div className="settings-policy-editor-footer">
        {isDirty ? <span>{t("Unsaved changes")}</span> : null}
        <button className="primary-button" type="button" onClick={onSave} disabled={isLoading || !isDirty}>
          {isLoading ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          {t("Save changes")}
        </button>
      </div>
    </div>
  );
}

function PermissionToolRow({
  tool,
  group,
  value,
  onChange,
}: {
  readonly tool: ToolName;
  readonly group: PermissionToolGroup;
  readonly value: ApprovalToolDecision;
  readonly onChange: (decision: ApprovalToolDecision) => void;
}): JSX.Element {
  const { t } = useI18n();
  const toolLabel = t(permissionToolLabelKeys[tool]);
  return (
    <div className="settings-permission-tool-row">
      <div>
        <strong>{toolLabel}</strong>
        <code>{tool}</code>
      </div>
      <PermissionDecisionControl
        label={`${t(group.labelKey)} · ${toolLabel}`}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function PermissionDecisionControl({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: PermissionGroupDecision;
  readonly onChange: (decision: ApprovalToolDecision) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-permission-decision-control" role="group" aria-label={t("{label} permission decision", { label })}>
      {permissionDecisionOptions.map((decision) => {
        const selected = value === decision;
        const labelKey = decision === "allow" ? "Allow" : decision === "ask" ? "Ask" : "Block";
        return (
          <button
            key={decision}
            className={selected ? "active" : ""}
            data-decision={decision}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(decision)}
          >
            <span className="settings-permission-decision-check" aria-hidden="true">
              {selected ? <Check size={12} /> : null}
            </span>
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
