import { Archive, Check, Pencil, RotateCcw, ShieldAlert, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  Select,
  StatusIndicator,
  Textarea,
} from "../../shared/ui/index.js";
import {
  memoryHealthFindingTitle,
  memoryReviewActionLabel,
  memoryScopeKindLabel,
  memoryScopeTypeLabel,
} from "./teammate-memory-view-models.js";
import type { TeammateMemoryController } from "./useTeammateMemoryController.js";

export function TeammateMemoryInspectorDrawer({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element {
  const { t } = useI18n();
  const detail = controller.detail;
  const busy = Boolean(controller.reviewingId);
  return (
    <Drawer open={Boolean(detail)} busy={busy} onOpenChange={(open) => { if (!open) controller.closeDetail(); }}>
      <DrawerContent size="md" className="teammate-memory-detail-drawer">
        <DrawerHeader title={t("Memory details")} description={detail ? detailDescription(detail, t) : undefined} closeLabel={t("Close")} />
        <DrawerBody className="teammate-memory-detail-body">
          {detail?.kind === "scope" ? <ScopeDetail controller={controller} /> : null}
          {detail?.kind === "health" ? <HealthDetail controller={controller} /> : null}
          {detail?.kind === "memory" ? <MemoryDetail controller={controller} /> : null}
        </DrawerBody>
        {detail?.kind === "memory" ? <MemoryActions controller={controller} /> : null}
      </DrawerContent>
    </Drawer>
  );
}

function ScopeDetail({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element | null {
  const { t } = useI18n();
  const detail = controller.detail;
  if (detail?.kind !== "scope") return null;
  return (
    <div className="teammate-memory-detail-stack">
      <StatusIndicator label={t(detail.scope.enabled ? "Active" : "Paused")} tone={detail.scope.enabled ? "success" : "warning"} />
      <h3>{t(memoryScopeKindLabel(detail.scope.kind))}</h3>
      <p>{detail.scope.channelId ? t("This scope belongs to one teammate channel.") : t("This scope belongs to the teammate private workspace.")}</p>
      <InspectorSection title={t("Sensitive and raw details")}>
        <RawValue label={t("Scope ID")} value={detail.scope.id} />
        <RawValue label={t("Owner ID")} value={detail.scope.teammateId} />
        {detail.scope.channelId ? <RawValue label={t("Channel ID")} value={detail.scope.channelId} /> : null}
      </InspectorSection>
    </div>
  );
}

function HealthDetail({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element | null {
  const { t } = useI18n();
  const detail = controller.detail;
  if (detail?.kind !== "health") return null;
  const finding = detail.finding;
  return (
    <div className="teammate-memory-detail-stack">
      <StatusIndicator
        label={t(finding.severity === "critical" ? "Critical" : finding.severity === "warning" ? "Warning" : "Info")}
        tone={finding.severity === "critical" ? "danger" : finding.severity === "warning" ? "warning" : "info"}
      />
      <h3>{t(memoryHealthFindingTitle(finding.kind))}</h3>
      <p>{t("Review the folded evidence before changing memory state.")}</p>
      <InspectorSection title={t("Sensitive and raw details")}>
        <RawValue label={t("Finding")} value={finding.title} />
        <RawValue label={t("Details")} value={finding.message} />
        <RawValue label={t("Recommended action")} value={finding.recommendation} />
        <RawValue label={t("Finding ID")} value={finding.id} />
        {finding.memoryId ? <RawValue label={t("Memory ID")} value={finding.memoryId} /> : null}
        {finding.ownerId ? <RawValue label={t("Owner ID")} value={finding.ownerId} /> : null}
        {finding.sensitivity ? <RawValue label={t("Sensitivity")} value={finding.sensitivity} /> : null}
      </InspectorSection>
    </div>
  );
}

function MemoryDetail({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element | null {
  const { t } = useI18n();
  const detail = controller.detail;
  if (detail?.kind !== "memory") return null;
  const item = detail.item;
  const editing = controller.editId === item.memory.id;
  return (
    <div className="teammate-memory-detail-stack">
      <div className="teammate-memory-detail-statuses">
        <StatusIndicator label={t("Needs review")} tone={item.memory.sensitivity === "secret-adjacent" ? "warning" : "neutral"} />
        <Badge tone={item.memory.sensitivity === "secret-adjacent" ? "warning" : "neutral"}>{t(memoryScopeTypeLabel(item.memory.scopeType))}</Badge>
      </div>
      <h3>{item.memory.title}</h3>
      {controller.reviewError ? <InlineFeedback tone="danger">{controller.reviewError}</InlineFeedback> : null}
      {editing ? (
        <div className="teammate-memory-edit-form">
          <Field label={t("Title")} required>
            <Input value={controller.editForm.title} disabled={Boolean(controller.reviewingId)} onChange={(event) => controller.setEditForm({ ...controller.editForm, title: event.target.value })} />
          </Field>
          <Field label={t("Body")} required>
            <Textarea rows={8} value={controller.editForm.body} disabled={Boolean(controller.reviewingId)} onChange={(event) => controller.setEditForm({ ...controller.editForm, body: event.target.value })} />
          </Field>
          <Field label={t("Sensitivity")}>
            <Select value={controller.editForm.sensitivity} disabled={Boolean(controller.reviewingId)} onChange={(event) => controller.setEditForm({ ...controller.editForm, sensitivity: event.target.value as typeof controller.editForm.sensitivity })}>
              <option value="normal">{t("Normal")}</option>
              <option value="private">{t("Private")}</option>
              <option value="secret-adjacent">{t("Secret-adjacent")}</option>
            </Select>
          </Field>
        </div>
      ) : (
        <InspectorSection title={t("Memory content")} summary={t("Open to read candidate body")}>
          <p className="teammate-memory-preserve-whitespace">{item.memory.body}</p>
        </InspectorSection>
      )}
      <InspectorSection title={t("Sensitive and raw details")}>
        <RawValue label={t("Source")} value={item.sourceSummary} />
        {item.memory.sourceRefs.map((source) => <RawValue key={`${source.type}:${source.id}`} label={source.label ?? source.type} value={source.id} />)}
        <RawValue label={t("Memory ID")} value={item.memory.id} />
        <RawValue label={t("Owner ID")} value={item.memory.ownerId} />
        <RawValue label={t("Sensitivity")} value={item.memory.sensitivity} />
        <RawValue label={t("Verify before use")} value={item.memory.verifyBeforeUse ? t("Yes") : t("No")} />
        {item.decision ? <RawValue label={t("Reason")} value={item.decision.reason} /> : null}
      </InspectorSection>
    </div>
  );
}

function MemoryActions({ controller }: { readonly controller: TeammateMemoryController }): React.JSX.Element | null {
  const { t } = useI18n();
  const detail = controller.detail;
  if (detail?.kind !== "memory") return null;
  const item = detail.item;
  const editing = controller.editId === item.memory.id;
  const busy = controller.reviewingId === item.memory.id;
  return (
    <DrawerFooter className="teammate-memory-detail-actions">
      {editing ? (
        <>
          <Button size="sm" variant="secondary" leadingIcon={<X />} disabled={busy} onClick={controller.cancelEdit}>{t("Cancel edit")}</Button>
          <Button size="sm" variant="primary" leadingIcon={<Check />} loading={busy} onClick={() => controller.requestReview(item, "edit_and_approve")}>{t("Save and approve")}</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" leadingIcon={<RotateCcw />} disabled={busy} onClick={() => controller.requestReview(item, "keep_candidate")}>{t(memoryReviewActionLabel("keep_candidate"))}</Button>
          <Button size="sm" variant="ghost" leadingIcon={<Pencil />} disabled={busy} onClick={() => controller.startEdit(item)}>{t("Edit")}</Button>
          <Button size="sm" variant="secondary" leadingIcon={<Check />} disabled={busy} onClick={() => controller.requestReview(item, "approve")}>{t("Approve")}</Button>
          <Button size="sm" variant="secondary" leadingIcon={<Archive />} disabled={busy} onClick={() => controller.requestReview(item, "archive")}>{t("Archive")}</Button>
          <Button size="sm" variant="danger" leadingIcon={<X />} disabled={busy} onClick={() => controller.requestReview(item, "reject")}>{t("Reject")}</Button>
          <Button size="sm" variant="danger" leadingIcon={<ShieldAlert />} disabled={busy} onClick={() => controller.requestReview(item, "quarantine")}>{t("Quarantine")}</Button>
        </>
      )}
    </DrawerFooter>
  );
}

function RawValue({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <span className="teammate-memory-raw-value"><strong>{label}</strong><code>{value}</code></span>;
}

function detailDescription(detail: NonNullable<TeammateMemoryController["detail"]>, t: ReturnType<typeof useI18n>["t"]): string {
  if (detail.kind === "scope") return t("Teammate memory scope");
  if (detail.kind === "health") return t("Memory health finding");
  return t("Workspace review candidate");
}
