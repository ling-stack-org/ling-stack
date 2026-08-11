import { Settings2, ShieldAlert, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  InlineFeedback,
  Select,
  Skeleton,
  StatusIndicator,
  Switch,
} from "../../shared/ui/index.js";
import type {
  AiTeammate,
  ApprovalPolicy,
  AuthorizationMode,
  PermissionPreset,
  SessionPermissionMode,
  SkillApprovalProfile,
  ToolName,
  WorkspaceAccessMode,
} from "../../types.js";
import {
  buildTeammatePermissionsViewModel,
  teammateCapabilityTools,
  type TeammatePermissionDecisionViewModel,
  type TeammatePermissionTone,
} from "./teammate-permissions-view-models.js";
import type { TeammatePermissionsController } from "./useTeammatePermissionsController.js";

export function TeammatePermissionsTab({
  controller,
  teammate,
  workspaceDefaultsAvailable,
  defaultAuthorizationMode,
  defaultWorkspaceAccessMode,
  defaultPermissionMode,
  defaultPermissionPreset,
  workspacePolicy,
  workspacePolicyLoading = false,
  workspacePolicyError,
  onRefreshWorkspacePolicy,
  onOpenAuthorizationSettings,
}: {
  readonly controller: TeammatePermissionsController;
  readonly teammate: AiTeammate;
  readonly workspaceDefaultsAvailable: boolean;
  readonly defaultAuthorizationMode?: AuthorizationMode;
  readonly defaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly defaultPermissionMode?: SessionPermissionMode;
  readonly defaultPermissionPreset?: PermissionPreset;
  readonly workspacePolicy?: ApprovalPolicy;
  readonly workspacePolicyLoading?: boolean;
  readonly workspacePolicyError?: string;
  readonly onRefreshWorkspacePolicy?: () => void;
  readonly onOpenAuthorizationSettings?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const viewModel = buildTeammatePermissionsViewModel({
    teammate,
    workspaceDefaultsAvailable,
    defaultAuthorizationMode,
    defaultWorkspaceAccessMode,
    defaultPermissionMode,
    defaultPermissionPreset,
    workspacePolicy,
  });
  const allowedTools = new Set(controller.allowedTools);
  const deniedTools = viewModel.workspace.toolDecisions.filter((tool) => (
    tool.decision === "deny" && allowedTools.has(tool.id)
  ));

  return (
    <section className="teammate-permissions-panel" data-ui2-teammate-permissions="true" aria-label={t("Tools and permissions")}>
      {controller.error ? <InlineFeedback tone="danger">{controller.error}</InlineFeedback> : null}

      <section className="teammate-permissions-section" aria-labelledby="teammate-capability-heading">
        <div className="teammate-permissions-section-heading">
          <div>
            <Wrench aria-hidden="true" />
            <h2 id="teammate-capability-heading">{t("Available capabilities")}</h2>
          </div>
        </div>
        <div className="teammate-permission-tool-list" role="list" aria-label={t("Available capabilities")}>
          {teammateCapabilityTools.map((tool) => {
            const decision = viewModel.workspace.toolDecisions.find((item) => item.id === tool);
            const enabled = allowedTools.has(tool);
            const presentation = capabilityPresentation(enabled, decision, t);
            return (
              <DataRow
                compact
                className="teammate-permission-tool-row"
                key={tool}
                role="listitem"
                identity={<strong>{t(toolLabelKey(tool))}</strong>}
                status={<StatusIndicator label={presentation.label} tone={presentation.tone} />}
                actions={(
                  <Switch
                    aria-label={t("Use capability for teammate: {name}", { name: t(toolLabelKey(tool)) })}
                    checked={enabled}
                    disabled={controller.saving}
                    onCheckedChange={() => controller.toggleTool(tool)}
                  />
                )}
              />
            );
          })}
        </div>
      </section>

      <section className="teammate-permissions-section" aria-labelledby="teammate-execution-scope-heading">
        <div className="teammate-permissions-section-heading">
          <div>
            <ShieldAlert aria-hidden="true" />
            <h2 id="teammate-execution-scope-heading">{t("Default execution scope")}</h2>
          </div>
        </div>

        {viewModel.workspace.available ? (
          <div className="teammate-permission-runtime-list" role="list">
            <DataRow
              compact
              className="teammate-permission-runtime-row"
              role="listitem"
              identity={<strong>{t("File access")}</strong>}
              status={<StatusIndicator label={t(viewModel.workspace.accessLabelKey)} tone={viewModel.workspace.accessTone} />}
            />
            <DataRow
              compact
              className="teammate-permission-runtime-row teammate-permission-approval-control"
              role="listitem"
              identity={<strong>{t("High-risk actions")}</strong>}
              actions={(
                <Select
                  aria-label={t("High-risk action confirmation")}
                  value={controller.approvalMode}
                  disabled={controller.saving}
                  onChange={(event) => controller.setApprovalMode(event.target.value as SkillApprovalProfile["mode"])}
                >
                  <option value="none">{t("Follow workspace rules")}</option>
                  <option value="standard">{t("Confirm before use")}</option>
                  <option value="strict">{t("Strict confirmation")}</option>
                </Select>
              )}
            />
          </div>
        ) : (
          <InlineFeedback tone="warning">{t("Workspace authorization defaults are not available yet.")}</InlineFeedback>
        )}

        {workspacePolicyLoading && !workspacePolicy ? (
          <div className="teammate-permission-runtime-loading" aria-label={t("Loading permission preview")}>
            <Skeleton width="72%" />
            <Skeleton width="48%" />
          </div>
        ) : null}
        {workspacePolicyError ? (
          <div className="teammate-permission-runtime-error">
            <InlineFeedback tone="danger">{t("Workspace policy could not be loaded.")}</InlineFeedback>
            {onRefreshWorkspacePolicy ? (
              <Button size="sm" variant="secondary" onClick={onRefreshWorkspacePolicy}>{t("Retry")}</Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {deniedTools.length > 0 ? (
        <InlineFeedback
          className="teammate-permission-workspace-warning"
          tone="warning"
          title={t("Workspace restrictions apply")}
        >
          <div className="teammate-permission-workspace-warning-content">
            <span>{t("Workspace has restricted: {tools}", {
              tools: deniedTools.map((tool) => t(tool.labelKey)).join(", "),
            })}</span>
            {onOpenAuthorizationSettings ? (
              <Button leadingIcon={<Settings2 />} size="sm" variant="secondary" onClick={onOpenAuthorizationSettings}>
                {t("Go to resolve")}
              </Button>
            ) : null}
          </div>
        </InlineFeedback>
      ) : null}

    </section>
  );
}

function capabilityPresentation(
  enabled: boolean,
  decision: TeammatePermissionDecisionViewModel | undefined,
  t: (key: string) => string,
): { readonly label: string; readonly tone: TeammatePermissionTone } {
  if (!enabled) return { label: t("Not in use"), tone: "neutral" };
  if (decision?.decision === "deny") return { label: t("Restricted by workspace"), tone: "warning" };
  if (decision?.decision === "ask") return { label: t("Confirm before use"), tone: "info" };
  return { label: t("Available"), tone: "success" };
}

function toolLabelKey(tool: ToolName): string {
  if (tool === "read") return "Read files";
  if (tool === "grep") return "Search file contents";
  if (tool === "find") return "Find files";
  if (tool === "ls") return "List folders";
  if (tool === "bash") return "Run commands";
  if (tool === "edit") return "Edit files";
  return "Write files";
}
