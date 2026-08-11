import { Archive, Copy, PauseCircle, Pin, Play, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { aiCouncilRoutingModeLabel, aiCouncilSourceLabel } from "../../lib/ai-councils.js";
import {
  Button,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  StatusIndicator,
  Switch,
  Textarea,
} from "../../shared/ui/index.js";
import type { AiCouncil } from "../../types.js";
import type { CouncilSettingsArchiveController } from "./useCouncilSettingsArchiveController.js";

export function CouncilSettingsPanel({
  canCloneCouncil,
  controller,
  onOpenCloneCouncil,
  selectedBoundaryLabels,
  selectedCapacityLabel,
}: {
  readonly canCloneCouncil: boolean;
  readonly controller: CouncilSettingsArchiveController;
  readonly onOpenCloneCouncil: () => void;
  readonly selectedBoundaryLabels: readonly string[];
  readonly selectedCapacityLabel?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const council = controller.authority;
  const view = controller.viewModel;

  return (
    <section
      className="council-detail-section council-settings-archive-panel"
      data-managed={view.managed || undefined}
      data-ui2-council-settings-archive="true"
      aria-label={t("Council settings")}
    >
      <header className="council-settings-archive-heading">
        <span>
          <ShieldCheck aria-hidden="true" />
          <strong>{t("Council settings")}</strong>
        </span>
        <StatusIndicator
          label={aiCouncilSourceLabel(council.source, t)}
          tone={view.managed ? "info" : "neutral"}
        />
      </header>

      <div className="council-settings-archive-scroll">
        {view.managed ? (
          <ManagedCouncilSettings council={council} />
        ) : (
          <EditableCouncilSettings controller={controller} />
        )}

        <CouncilLifecycleAction controller={controller} />

        <InspectorSection
          aria-label={t("Council boundaries")}
          className="council-settings-archive-boundaries"
          summary={t("Technical details stay folded by default")}
          title={t("Council boundaries")}
        >
          <div className="council-settings-archive-boundary-list">
            <span>{aiCouncilSourceLabel(council.source, t)}</span>
            <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
            {selectedCapacityLabel ? <span>{selectedCapacityLabel}</span> : null}
            {selectedBoundaryLabels.map((label) => <span key={label}>{label}</span>)}
          </div>
        </InspectorSection>

        <InspectorSection
          aria-label={t("Council actions")}
          className="council-settings-archive-more-actions"
          summary={t("Clone council")}
          title={t("More council actions")}
        >
          <section className="council-settings-archive-secondary">
            <span>
              <strong>{t("Clone council")}</strong>
              <small>{t("Members and routing will be copied")}</small>
            </span>
            <Button
              disabled={!canCloneCouncil}
              leadingIcon={<Copy aria-hidden="true" />}
              size="sm"
              variant="secondary"
              onClick={onOpenCloneCouncil}
            >
              {t("Clone council")}
            </Button>
          </section>
        </InspectorSection>

        <CouncilDangerSection controller={controller} />
      </div>
    </section>
  );
}

function EditableCouncilSettings({
  controller,
}: {
  readonly controller: CouncilSettingsArchiveController;
}): React.JSX.Element {
  const { t } = useI18n();
  const view = controller.viewModel;
  const controlsDisabled = Boolean(controller.mutationKind) || controller.archiveBusy;

  return (
    <form
      className="council-settings-archive-form"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.save();
      }}
    >
      <div className="council-settings-archive-fields">
        <Field
          label={t("Council name")}
          required
        >
          <Input
            aria-label={t("Council name")}
            disabled={controlsDisabled}
            value={controller.draft.displayName}
            onChange={(event) => controller.setDraft({ displayName: event.currentTarget.value })}
          />
        </Field>
        <Field className="council-settings-archive-description" label={t("Council description")}>
          <Textarea
            aria-label={t("Council description")}
            disabled={controlsDisabled}
            rows={3}
            value={controller.draft.description}
            onChange={(event) => controller.setDraft({ description: event.currentTarget.value })}
          />
        </Field>
        <label className="council-settings-archive-switch-row">
          <span>
            <Pin aria-hidden="true" />
            <strong>{t("Pin council")}</strong>
          </span>
          <Switch
            aria-label={t("Pin council")}
            checked={controller.draft.pinned}
            disabled={controlsDisabled}
            onCheckedChange={(checked) => controller.setDraft({ pinned: checked })}
          />
        </label>
      </div>
      {controller.settingsError ? (
        <InlineFeedback tone="danger" title={t("Save council settings")}>
          {controller.settingsError}
        </InlineFeedback>
      ) : null}
      <div className="council-settings-archive-form-actions">
        <Button
          disabled={!view.canReset}
          leadingIcon={<RotateCcw aria-hidden="true" />}
          size="sm"
          variant="secondary"
          onClick={controller.resetDraft}
        >
          {t("Reset")}
        </Button>
        <Button
          disabled={!view.canSave}
          leadingIcon={<Save aria-hidden="true" />}
          loading={controller.mutationKind === "save"}
          loadingLabel={t("Saving settings...")}
          size="sm"
          type="submit"
          variant="primary"
        >
          {t("Save council settings")}
        </Button>
      </div>
    </form>
  );
}

function ManagedCouncilSettings({ council }: { readonly council: AiCouncil }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="council-settings-archive-managed">
      <InlineFeedback tone="info" title={t("Built-in councils must be cloned before editing")}>
        {t("Managed by Ling Stack")}
      </InlineFeedback>
      <dl>
        <div><dt>{t("Council name")}</dt><dd title={council.displayName}>{council.displayName}</dd></div>
        <div><dt>{t("Council description")}</dt><dd>{council.description || t("No council description")}</dd></div>
      </dl>
    </div>
  );
}

function CouncilLifecycleAction({
  controller,
}: {
  readonly controller: CouncilSettingsArchiveController;
}): React.JSX.Element {
  const { t } = useI18n();
  const action = controller.viewModel.statusAction;
  const managed = controller.viewModel.managed;
  const paused = action === "resume";

  return (
    <section className="council-settings-archive-lifecycle" aria-label={t("Status")}>
      <span>
        <strong>{paused ? t("Paused") : t("Active")}</strong>
        <small>{paused ? t("This council is paused and will not be used for channel collaboration.") : t("Available configuration")}</small>
      </span>
      {!managed ? (
        <Button
          disabled={!controller.viewModel.canToggleStatus}
          leadingIcon={paused ? <Play aria-hidden="true" /> : <PauseCircle aria-hidden="true" />}
          loading={controller.mutationKind === "status"}
          loadingLabel={t(paused ? "Resuming council..." : "Pausing council...")}
          size="sm"
          variant="secondary"
          onClick={() => void controller.toggleStatus()}
        >
          {t(paused ? "Resume council" : "Pause council")}
        </Button>
      ) : null}
      {controller.statusError ? (
        <InlineFeedback className="council-settings-archive-lifecycle-error" tone="danger" title={t(paused ? "Resume council" : "Pause council")}>
          {controller.statusError}
        </InlineFeedback>
      ) : null}
    </section>
  );
}

function CouncilDangerSection({
  controller,
}: {
  readonly controller: CouncilSettingsArchiveController;
}): React.JSX.Element {
  const { t } = useI18n();
  const managed = controller.viewModel.managed;

  return (
    <section className="council-danger-zone" aria-label={t("Danger zone")}>
      <header>
        <Archive aria-hidden="true" />
        <strong>{t("Danger zone")}</strong>
      </header>
      {managed ? (
        <InlineFeedback tone="info" title={t("Read only")}>
          {t("Built-in councils must be cloned before editing")}
        </InlineFeedback>
      ) : (
        <div className="council-danger-zone-action">
          <span>
            <strong>{t("Archive council")}</strong>
            <small>{controller.authority.displayName}</small>
          </span>
          <Button
            ref={controller.archiveTriggerRef}
            disabled={!controller.viewModel.canArchive}
            leadingIcon={<Archive aria-hidden="true" />}
            size="sm"
            variant="danger"
            onClick={controller.requestArchive}
          >
            {t("Archive council")}
          </Button>
        </div>
      )}
    </section>
  );
}
