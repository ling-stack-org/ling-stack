import { LockKeyhole, Settings2, ShieldCheck, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Button,
  DataRow,
  InlineFeedback,
  InspectorSection,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type {
  AiTeammate,
  ApprovalPolicy,
  AuthorizationMode,
  PermissionPreset,
  SessionPermissionMode,
  WorkspaceAccessMode,
} from "../../types.js";
import { buildTeammatePermissionsViewModel } from "./teammate-permissions-view-models.js";

export function TeammatePermissionsTab({
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
}): JSX.Element {
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
  const requirementCount = viewModel.requiredTools.length + viewModel.requiredActions.length;

  return (
    <section
      className="teammate-permissions-panel"
      data-ui2-teammate-permissions="true"
      aria-label={t("Permissions")}
    >
      <header className="teammate-permissions-heading">
        <div>
          <ShieldCheck aria-hidden="true" />
          <h2>{t("Permissions")}</h2>
        </div>
        <StatusIndicator
          label={t(viewModel.statusLabelKey)}
          tone={viewModel.statusTone}
        />
      </header>

      <section className="teammate-permissions-section" aria-labelledby="teammate-capability-heading">
        <div className="teammate-permissions-section-heading">
          <div>
            <Wrench aria-hidden="true" />
            <h3 id="teammate-capability-heading">{t("Teammate capability ceiling")}</h3>
          </div>
          <Badge tone="neutral" variant="outline">
            {t("{count} of {total} tools", { count: viewModel.toolCount, total: viewModel.totalToolCount })}
          </Badge>
        </div>

        <DataRow
          compact
          className="teammate-permission-approval-row"
          identity={(
            <span className="teammate-permission-row-copy">
              <strong>{t("Approval profile")}</strong>
              <small>{t(viewModel.approval.summaryKey)}</small>
            </span>
          )}
          status={<StatusIndicator label={t(viewModel.approval.labelKey)} tone={viewModel.approval.tone} />}
        />

        {viewModel.tools.length > 0 ? (
          <div className="teammate-permission-tool-list" role="list" aria-label={t("Allowed tools")}>
            {viewModel.tools.map((tool) => (
              <DataRow
                compact
                className="teammate-permission-tool-row"
                key={tool.id}
                role="listitem"
                identity={(
                  <span className="teammate-permission-row-copy">
                    <strong>{t(tool.labelKey)}</strong>
                    <small>{t(tool.impactLabelKey)}</small>
                  </span>
                )}
              />
            ))}
          </div>
        ) : (
          <InlineFeedback tone="warning">
            {t("This teammate does not declare a tool capability ceiling. Runtime policy can only restrict it further.")}
          </InlineFeedback>
        )}

        <InspectorSection
          className="teammate-permission-policy-details"
          title={t("Policy details")}
          summary={requirementCount > 0
            ? t("{count} additional requirements", { count: requirementCount })
            : t("No additional requirements")}
        >
          <dl className="teammate-permission-detail-list">
            <div>
              <dt>{t("Tool identifiers")}</dt>
              <dd>{viewModel.rawToolIds.length > 0 ? viewModel.rawToolIds.join(", ") : t("None")}</dd>
            </div>
            <div>
              <dt>{t("Approval required for tools")}</dt>
              <dd>{viewModel.requiredTools.length > 0
                ? viewModel.requiredTools.map((item) => t(item.labelKey)).join(", ")
                : t("None")}</dd>
            </div>
            <div>
              <dt>{t("Approval required for actions")}</dt>
              <dd>{viewModel.requiredActions.length > 0
                ? viewModel.requiredActions.map((item) => t(item.labelKey)).join(", ")
                : t("None")}</dd>
            </div>
          </dl>
        </InspectorSection>
      </section>

      <section className="teammate-permissions-section" aria-labelledby="teammate-runtime-preview-heading">
        <div className="teammate-permissions-section-heading">
          <div>
            <LockKeyhole aria-hidden="true" />
            <h3 id="teammate-runtime-preview-heading">{t("Workspace default runtime preview")}</h3>
          </div>
        </div>

        {viewModel.workspace.available ? (
          <>
            <div className="teammate-permission-runtime-list" role="list">
              <DataRow
                compact
                className="teammate-permission-runtime-row"
                role="listitem"
                identity={<strong>{t("Default authorization")}</strong>}
                status={(
                  <StatusIndicator
                    label={t(viewModel.workspace.authorizationLabelKey)}
                    tone={viewModel.workspace.authorizationTone}
                  />
                )}
              />
              <DataRow
                compact
                className="teammate-permission-runtime-row"
                role="listitem"
                identity={<strong>{t("Sandbox settings")}</strong>}
                status={(
                  <StatusIndicator
                    label={t(viewModel.workspace.accessLabelKey)}
                    tone={viewModel.workspace.accessTone}
                  />
                )}
              />
            </div>
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
                  <Button size="sm" variant="secondary" onClick={onRefreshWorkspacePolicy}>
                    {t("Retry")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {viewModel.workspace.deniedToolLabelKeys.length > 0 ? (
              <InlineFeedback tone="warning">
                {t("Workspace policy blocks {tools}. Teammate settings cannot allow them.", {
                  tools: viewModel.workspace.deniedToolLabelKeys.map((key) => t(key)).join(", "),
                })}
              </InlineFeedback>
            ) : null}
            {viewModel.workspace.toolDecisions.length > 0 ? (
              <InspectorSection
                className="teammate-permission-runtime-details"
                title={t("Default tool decisions")}
                summary={t("{allow} allowed · {ask} ask · {deny} denied", viewModel.workspace.decisionCounts)}
              >
                <div className="teammate-permission-runtime-decision-list" role="list">
                  {viewModel.workspace.toolDecisions.map((tool) => (
                    <DataRow
                      compact
                      className="teammate-permission-runtime-decision-row"
                      key={tool.id}
                      role="listitem"
                      identity={<strong>{t(tool.labelKey)}</strong>}
                      status={<StatusIndicator label={t(tool.decisionLabelKey)} tone={tool.decisionTone} />}
                    />
                  ))}
                </div>
              </InspectorSection>
            ) : null}
          </>
        ) : (
          <InlineFeedback tone="warning">{t("Workspace authorization defaults are not available yet.")}</InlineFeedback>
        )}

        <p className="teammate-permission-runtime-note">
          {t("Channels, skills, sessions, and runs may further restrict execution.")}
        </p>
        {onOpenAuthorizationSettings ? (
          <div className="teammate-permission-runtime-actions">
            <Button
              leadingIcon={<Settings2 />}
              size="sm"
              variant="secondary"
              onClick={onOpenAuthorizationSettings}
            >
              {t("Open authorization settings")}
            </Button>
          </div>
        ) : null}
      </section>
    </section>
  );
}
