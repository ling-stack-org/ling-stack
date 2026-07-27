import { Plus, Unlink, X } from "lucide-react";
import type { RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { approvalProfileText } from "./helpers.js";
import { teammateSkillActionLabel, type TeammateSkillRowModel } from "./teammate-skills-view-models.js";

export function TeammateSkillInspectorDrawer({
  mutationKey,
  open,
  returnFocusRef,
  row,
  onOpenChange,
  onRemoveBinding,
  onToggleBinding,
}: {
  readonly mutationKey: string;
  readonly open: boolean;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly row: TeammateSkillRowModel | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemoveBinding: (skillId: string) => void | Promise<void>;
  readonly onToggleBinding: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const actionBusy = row ? mutationKey.endsWith(`:${row.id}`) : false;

  return (
    <Drawer busy={actionBusy} open={open && Boolean(row)} onOpenChange={onOpenChange}>
      <DrawerContent
        className="teammate-skill-detail-drawer"
        size="md"
        onEscapeKeyDown={(event) => {
          if (actionBusy) return;
          event.preventDefault();
          onOpenChange(false);
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || actionBusy) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          globalThis.requestAnimationFrame(() => returnFocusRef.current?.focus());
        }}
      >
        <DrawerHeader
          closeLabel={t("Close")}
          title={t("Skill detail")}
          description={row?.displayName}
        />
        {row ? (
          <>
            <DrawerBody>
              <div className="teammate-skill-detail-status">
                <StatusIndicator label={row.status.label} tone={row.status.tone} />
                <StatusIndicator compact label={row.sourceState.label} tone={row.sourceState.tone} />
              </div>

              <section className="teammate-skill-detail-section">
                <h3>{t("Description")}</h3>
                <p>{row.summary}</p>
              </section>

              <section className="teammate-skill-detail-section">
                <h3>{t("Blocked reasons")}</h3>
                {row.effectiveSkill?.blockedReasons.length ? (
                  <div className="teammate-skill-detail-reasons">
                    {row.effectiveSkill.blockedReasons.map((reason) => (
                      <InlineFeedback key={reason.code} tone="warning" title={t(reason.code)}>
                        {reason.missing?.length ? reason.missing.join(", ") : reason.message}
                      </InlineFeedback>
                    ))}
                  </div>
                ) : (
                  <p>{row.binding?.enabled ? t("No blocked reasons") : t("Bind this skill to evaluate executability.")}</p>
                )}
              </section>

              <InspectorSection
                open
                className="teammate-skill-detail-requirements"
                title={t("Requirements and policy")}
                summary={t("{count} required tools", { count: row.skill?.requiredTools.length ?? 0 })}
              >
                <DetailTokens label={t("Required tools")} values={row.skill?.requiredTools ?? []} empty={t("No tools")} />
                <DetailTokens
                  label={t("Provider capability")}
                  values={row.skill?.requiredProviderCapabilities ?? []}
                  empty={t("No provider capability required")}
                />
                <div className="teammate-skill-detail-value">
                  <strong>{t("Approval profile")}</strong>
                  <span>{row.skill ? approvalProfileText(row.skill.approvalProfile, t) : "-"}</span>
                </div>
              </InspectorSection>

              <InspectorSection
                className="teammate-skill-detail-raw"
                title={t("Source and raw details")}
                summary={row.sourceLabel}
              >
                <div className="teammate-skill-detail-value">
                  <strong>{t("Skill id")}</strong>
                  <code>{row.id}</code>
                </div>
                <div className="teammate-skill-detail-value">
                  <strong>{t("Prompt fragments")}</strong>
                  {row.skill?.promptFragments.length
                    ? <pre>{row.skill.promptFragments.slice(0, 3).join("\n\n")}</pre>
                    : <span>{t("No prompt fragments")}</span>}
                </div>
                {row.sourceSnapshot ? (
                  <div className="teammate-skill-source-raw-grid">
                    <RawValue label={t("Snapshot")} value={row.sourceSnapshot.id} />
                    <RawValue label={t("Checksum")} value={row.sourceSnapshot.sourceChecksum} />
                    <RawValue
                      label={t("Path")}
                      value={row.sourceSnapshot.upstreamSkillPath ?? row.sourceSnapshot.sourcePath ?? "-"}
                    />
                    <RawValue label={t("Review")} value={row.sourceSnapshot.reviewStatus} />
                  </div>
                ) : <p>{t("No source snapshot is available.")}</p>}
              </InspectorSection>
            </DrawerBody>
            <DrawerFooter>
              {row.canRemove ? (
                <Button
                  leadingIcon={<Unlink />}
                  variant="danger"
                  disabled={Boolean(mutationKey)}
                  loading={mutationKey === `remove:${row.id}`}
                  loadingLabel={t("Removing")}
                  onClick={() => void onRemoveBinding(row.id)}
                >
                  {t("Remove from teammate")}
                </Button>
              ) : null}
              <Button
                leadingIcon={row.primaryAction === "disable" ? <X /> : <Plus />}
                variant="primary"
                disabled={Boolean(mutationKey)}
                loading={mutationKey === `${row.primaryAction}:${row.id}`}
                loadingLabel={t("Saving...")}
                onClick={() => void onToggleBinding(row.id)}
              >
                {teammateSkillActionLabel(row.primaryAction, t)}
              </Button>
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function DetailTokens({
  empty,
  label,
  values,
}: {
  readonly empty: string;
  readonly label: string;
  readonly values: readonly string[];
}): JSX.Element {
  return (
    <div className="teammate-skill-detail-value">
      <strong>{label}</strong>
      {values.length > 0 ? (
        <span className="teammate-skill-detail-tokens">
          {values.map((value) => <Badge key={value} variant="outline">{value}</Badge>)}
        </span>
      ) : <span>{empty}</span>}
    </div>
  );
}

function RawValue({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <span>
      <small>{label}</small>
      <code title={value}>{value}</code>
    </span>
  );
}
