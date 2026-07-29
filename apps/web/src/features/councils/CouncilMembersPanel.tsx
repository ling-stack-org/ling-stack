import { ArrowRight, Copy, Plus, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { AiCouncil } from "../../types.js";
import {
  Button,
  EmptyState,
  IconButton,
  InlineFeedback,
  Select,
  Skeleton,
} from "../../shared/ui/index.js";
import { CouncilMemberRemoveDialog } from "./CouncilMemberRemoveDialog.js";
import { CouncilMemberRow } from "./CouncilMemberRow.js";
import type { CouncilMembersController } from "./useCouncilMembersController.js";

export function CouncilMembersPanel({
  cloneDisabled,
  controller,
  council,
  cwd,
  onOpenCloneCouncil,
  onOpenTeammates,
}: {
  readonly cloneDisabled: boolean;
  readonly controller: CouncilMembersController;
  readonly council: AiCouncil;
  readonly cwd: string;
  readonly onOpenCloneCouncil: () => void;
  readonly onOpenTeammates: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const feedback = membersFeedback(controller, t);

  return (
    <>
      <section aria-label={t("Council members")} className="council-detail-section council-members-panel">
        <div className="council-members-summary">
          <span className="council-members-summary-copy">
            <strong>{t("Council members")}</strong>
            <small title={controller.evidence.reason}>{controller.summary.label}</small>
          </span>
          <span className="council-members-summary-actions">
            <IconButton
              disabled={controller.mutationBusy || controller.initialLoading}
              icon={RefreshCw}
              label={t("Refresh")}
              loading={controller.refreshBusy}
              onClick={() => void controller.refreshMembers()}
            />
            {controller.managed ? (
              <Button
                disabled={cloneDisabled}
                leadingIcon={<Copy />}
                onClick={onOpenCloneCouncil}
                size="sm"
                variant="primary"
              >
                {t("Clone to customize")}
              </Button>
            ) : controller.candidates.length > 0 ? (
              <Button leadingIcon={<ArrowRight />} onClick={onOpenTeammates} size="sm" variant="secondary">
                {t("Manage teammates")}
              </Button>
            ) : null}
          </span>
        </div>

        {controller.managed ? (
          <InlineFeedback className="council-members-managed" tone="info" title={t("Built-in councils must be cloned before editing")} />
        ) : null}
        {council.status === "paused" ? (
          <InlineFeedback className="council-members-feedback" tone="info" title={t("Paused") }>
            {t("This council is paused and will not be used for channel collaboration.")}
          </InlineFeedback>
        ) : null}
        {feedback ? (
          <InlineFeedback className="council-members-feedback" tone={feedback.tone} title={feedback.title}>
            <span className="council-members-feedback-detail">
              <span>{feedback.detail}</span>
              {feedback.action ? (
                <Button
                  disabled={feedback.action.disabled}
                  loading={feedback.action.loading}
                  loadingLabel={t("Loading...")}
                  onClick={feedback.action.run}
                  size="sm"
                  variant="secondary"
                >
                  {feedback.action.label}
                </Button>
              ) : null}
            </span>
          </InlineFeedback>
        ) : null}

        {!controller.managed ? (
          controller.candidates.length > 0 ? (
            <div className="council-members-add-row">
              <Select
                ref={controller.addSelectRef}
                aria-label={t("Add teammate to council")}
                disabled={controller.mutationDisabled}
                size="sm"
                value={controller.pendingTeammateId}
                onChange={(event) => controller.setPendingTeammateId(event.target.value)}
              >
                <option value="">{t("Select teammate")}</option>
                {controller.candidates.map((candidate) => (
                  <option key={candidate.teammate.id} value={candidate.teammate.id}>{candidate.label}</option>
                ))}
              </Select>
              <Button
                disabled={controller.mutationDisabled || !controller.pendingTeammateId}
                leadingIcon={<Plus />}
                loading={controller.mutationKind === "add"}
                loadingLabel={t("Saving...")}
                onClick={controller.addMember}
                size="sm"
              >
                {t("Add member")}
              </Button>
            </div>
          ) : (
            <EmptyState
              action={<Button onClick={onOpenTeammates} size="sm">{t("Manage teammates")}</Button>}
              className="council-members-candidate-empty"
              compact
              title={t("No teammates available to add")}
              description={t("Create or unhide teammates before adding them to this council.")}
            />
          )
        ) : null}

        {controller.initialLoading ? (
          <div className="council-members-skeleton-list" aria-label={t("Loading council members...")}>
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="council-members-skeleton-row">
                <Skeleton height={30} shape="circle" width={30} />
                <span><Skeleton width="58%" /><Skeleton width="36%" /></span>
                <Skeleton height={22} width={82} />
                <Skeleton height={32} width={142} />
              </span>
            ))}
          </div>
        ) : controller.rows.length === 0 ? (
          <EmptyState
            className="council-members-empty"
            compact
            title={t("No council members")}
            description={t("Add teammates to make this council useful in channel work.")}
          />
        ) : (
          <div className="council-members-list" role="list" aria-label={t("Members")}>
            {controller.rows.map((row, index) => (
              <CouncilMemberRow
                key={`${row.member.councilId}:${row.member.teammateId}`}
                cwd={cwd}
                editable={!controller.managed}
                index={index}
                mutationDisabled={controller.mutationDisabled}
                mutationKind={controller.mutationKind}
                mutationTargetId={controller.mutationTargetId}
                onMove={controller.moveMember}
                onRemove={controller.requestRemove}
                onToggle={controller.toggleMember}
                row={row}
                total={controller.rows.length}
              />
            ))}
          </div>
        )}
      </section>
      <CouncilMemberRemoveDialog
        busy={controller.mutationKind === "remove"}
        error={controller.removeError}
        lastEnabled={controller.removeLastEnabled}
        target={controller.removeTarget}
        onConfirm={controller.confirmRemove}
        onOpenChange={controller.requestRemoveOpenChange}
        onRestoreFocus={controller.restoreRemoveFocus}
      />
    </>
  );
}

function membersFeedback(
  controller: CouncilMembersController,
  t: ReturnType<typeof useI18n>["t"],
): {
  readonly action?: { readonly disabled: boolean; readonly label: string; readonly loading: boolean; readonly run: () => void };
  readonly detail: string;
  readonly title: string;
  readonly tone: "danger" | "info" | "warning";
} | undefined {
  if (controller.loadError) {
    return {
      action: {
        disabled: controller.refreshBusy,
        label: t("Retry"),
        loading: controller.refreshBusy,
        run: () => void controller.refreshMembers(),
      },
      detail: controller.loadError,
      title: controller.stale ? t("Stale snapshot") : t("Council refresh failed"),
      tone: controller.stale ? "warning" : "danger",
    };
  }
  if (controller.conflict) {
    return {
      detail: t("Council members changed elsewhere. Review the latest list and repeat your action."),
      title: controller.conflict,
      tone: "warning",
    };
  }
  if (controller.mutationError) {
    return { detail: controller.mutationError, title: t("Review changes"), tone: "danger" };
  }
  if (controller.readinessError) {
    return {
      action: {
        disabled: controller.readinessBusy,
        label: t("Retry"),
        loading: controller.readinessBusy,
        run: () => void controller.refreshReadiness(),
      },
      detail: controller.readinessError,
      title: t("Readiness warning"),
      tone: "warning",
    };
  }
  if (!controller.evidence.complete && controller.rows.length > 0) {
    return {
      action: {
        disabled: controller.readinessBusy,
        label: t("Refresh"),
        loading: controller.readinessBusy,
        run: () => void controller.refreshReadiness(),
      },
      detail: controller.evidence.reason ?? t("Refresh to load member readiness."),
      title: t("Health information is incomplete."),
      tone: "info",
    };
  }
  return undefined;
}
