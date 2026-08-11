import { Unlink } from "lucide-react";
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
  Switch,
} from "../../shared/ui/index.js";
import { approvalProfileText } from "./helpers.js";
import type { TeammateSkillRowModel } from "./teammate-skills-view-models.js";

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
}): React.JSX.Element {
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
        <DrawerHeader closeLabel={t("Close")} title={row?.displayName ?? t("Skill detail")} description={row?.summary} />
        {row ? (
          <>
            <DrawerBody>
              <div className="teammate-skill-detail-use">
                <strong>{t("Use for this teammate")}</strong>
                <Switch
                  aria-label={t("Use skill for teammate: {name}", { name: row.displayName })}
                  checked={Boolean(row.binding?.enabled)}
                  disabled={Boolean(mutationKey)}
                  loading={actionBusy}
                  onCheckedChange={() => void onToggleBinding(row.id)}
                />
              </div>

              {row.effectiveSkill?.blockedReasons.length ? (
                <section className="teammate-skill-detail-section">
                  <h3>{t("Blocked reasons")}</h3>
                  <div className="teammate-skill-detail-reasons">
                    {row.effectiveSkill.blockedReasons.map((reason) => (
                      <InlineFeedback key={reason.code} tone="warning" title={t(reason.code)}>
                        {reason.missing?.length ? reason.missing.join(", ") : reason.message}
                      </InlineFeedback>
                    ))}
                  </div>
                </section>
              ) : null}

              {!row.skill ? (
                <InlineFeedback tone="danger">{t("This binding points to a Skill that is no longer available.")}</InlineFeedback>
              ) : null}

              {row.sourceState.attention ? (
                <InlineFeedback tone="warning">{row.sourceState.label}</InlineFeedback>
              ) : null}

              <InspectorSection
                className="teammate-skill-detail-requirements"
                title={t("Requirements and policy")}
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

              <InspectorSection className="teammate-skill-detail-raw" title={t("Technical information")}>
                <div className="teammate-skill-detail-status">
                  <StatusIndicator compact label={row.status.label} tone={row.status.tone} />
                  <StatusIndicator compact label={row.sourceState.label} tone={row.sourceState.tone} />
                </div>
                <div className="teammate-skill-detail-value">
                  <strong>{t("Skill id")}</strong>
                  <code>{row.id}</code>
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
                ) : null}
              </InspectorSection>
            </DrawerBody>
            {row.canRemove ? (
              <DrawerFooter>
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
              </DrawerFooter>
            ) : null}
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
}): React.JSX.Element {
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

function RawValue({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <span>
      <small>{label}</small>
      <code title={value}>{value}</code>
    </span>
  );
}
