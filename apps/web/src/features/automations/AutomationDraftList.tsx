import { Check, Trash2 } from "lucide-react";
import { Button, DataRow, IconButton, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { AutomationDraftMutationKind } from "../../domains/automations/use-automations-domain.js";
import type { AutomationDraftViewModel, AutomationTranslate } from "./automation-view-models.js";

export function AutomationDraftList({
  actionById,
  drafts,
  errorById,
  selectedDraftId,
  t,
  onConfirm,
  onDiscard,
  onSelect,
}: {
  readonly actionById: Readonly<Record<string, AutomationDraftMutationKind | undefined>>;
  readonly drafts: readonly AutomationDraftViewModel[];
  readonly errorById: Readonly<Record<string, string | undefined>>;
  readonly selectedDraftId: string;
  readonly t: AutomationTranslate;
  readonly onConfirm: (draftId: string) => void;
  readonly onDiscard: (draftId: string) => void;
  readonly onSelect: (draftId: string) => void;
}): React.JSX.Element {
  return (
    <section className="automation-ui2-draft-section" aria-label={t("Draft review")}>
      <h2>{t("Drafts waiting for confirmation")}</h2>
      <div className="automation-ui2-draft-list" role="listbox">
        {drafts.map((item) => {
          const action = actionById[item.draft.id];
          const error = errorById[item.draft.id];
          return (
            <DataRow
              key={item.draft.id}
              className="automation-ui2-draft-row"
              identity={(
                <div className="automation-ui2-row-identity">
                  <strong>{item.draft.title ?? t("Untitled draft")}</strong>
                  {item.draft.missingFields.length ? <span>{t("Missing")} · {item.draft.missingFields.join(", ")}</span> : null}
                  {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
                </div>
              )}
              selected={selectedDraftId === item.draft.id}
              status={<StatusIndicator compact label={item.statusLabel} tone={item.statusTone} />}
              summary={<span>{item.targetLabel} · {item.scheduleLabel}</span>}
              actions={(
                <div className="automation-ui2-row-actions" onClick={(event) => event.stopPropagation()}>
                  <Button
                    disabled={!item.ready}
                    leadingIcon={<Check aria-hidden="true" size={14} />}
                    loading={action === "confirm"}
                    loadingLabel={t("Confirm automation")}
                    onClick={() => onConfirm(item.draft.id)}
                    size="sm"
                    variant="secondary"
                  >
                    {t("Confirm")}
                  </Button>
                  <IconButton
                    disabled={Boolean(action)}
                    icon={Trash2}
                    label={t("Discard")}
                    onClick={() => onDiscard(item.draft.id)}
                    variant="danger"
                  />
                </div>
              )}
              onClick={() => onSelect(item.draft.id)}
            />
          );
        })}
      </div>
    </section>
  );
}
