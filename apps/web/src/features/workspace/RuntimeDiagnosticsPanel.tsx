import { Activity, CircleAlert, FileCheck2, FileText, Loader2, RefreshCw, ShieldCheck, SlidersHorizontal, Workflow, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow } from "../../shared/components/index.js";
import { StatusIndicator } from "../../shared/ui/index.js";
import type { ResourceLease, RuntimeDiagnosticsResponse, WorkUnit } from "../../types.js";
import {
  resourceLeaseStatusPresentation,
  runtimeSemaphoreStatusPresentation,
  workUnitStatusPresentation,
} from "./runtime-status-view-models.js";

export function RuntimeDiagnosticsPanel({
  diagnostics,
  workUnits,
  loading,
  actionWorkUnitId,
  onRefresh,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
}: {
  readonly diagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly loading: boolean;
  readonly actionWorkUnitId: string;
  readonly onRefresh: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const active = diagnostics?.active ?? workUnits.filter(isActiveWorkUnit);
  const queued = diagnostics?.queued ?? workUnits.filter((unit) => unit.status === "queued");
  const stuck = diagnostics?.stuck ?? [];
  const stale = diagnostics?.stale ?? workUnits.filter((unit) => unit.status === "stale");
  const leases = diagnostics?.leases ?? [];
  const semaphoreSlots = diagnostics?.semaphoreSlots ?? [];
  const visibleUnits = uniqueWorkUnits([...stuck, ...active, ...queued, ...stale, ...workUnits]).slice(0, 8);

  return (
    <section className="runtime-diagnostics-panel" aria-label={t("Runtime diagnostics")}>
      <div className="task-strip-head">
        <span><Activity size={15} /><strong>{t("Runtime supervisor")}</strong></span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Check status")}
        </button>
      </div>

      {diagnostics ? (
        <div className="runtime-supervisor-meta">
          <MetaRow label={t("Runtime")} value={diagnostics.runtime.runtimeInstanceId} compact />
          <MetaRow label={t("PID")} value={String(diagnostics.runtime.pid)} compact />
          <MetaRow label={t("Status")} value={diagnostics.runtime.status} compact />
          <MetaRow label={t("Started")} value={formatDateTime(diagnostics.runtime.startedAt)} compact />
        </div>
      ) : (
        <div className="provider-run-notice compact">
          <CircleAlert size={14} />
          <span>{t("Runtime diagnostics are unavailable.")}</span>
        </div>
      )}

      <div className="runtime-kpi-grid">
        <div>
          <span>{t("Active")}</span>
          <strong>{active.length}</strong>
        </div>
        <div>
          <span>{t("Queued")}</span>
          <strong>{queued.length}</strong>
        </div>
        <div>
          <span>{t("Stuck")}</span>
          <strong>{stuck.length}</strong>
        </div>
        <div>
          <span>{t("Stale")}</span>
          <strong>{stale.length}</strong>
        </div>
      </div>

      <div className="task-strip-head">
        <span><Workflow size={15} /><strong>{t("Work units")}</strong></span>
        <small>{visibleUnits.length}</small>
      </div>
      <RuntimeProtocolList
        emptyLabel={t("No work units recorded")}
        items={visibleUnits}
        renderItem={(unit) => (
          <WorkUnitDiagnosticsRow
            key={unit.id}
            workUnit={unit}
            busy={actionWorkUnitId === unit.id}
            onCancel={onCancelWorkUnit}
            onRetry={onRetryWorkUnit}
            onReconcile={onReconcileWorkUnit}
          />
        )}
      />

      <div className="task-strip-head">
        <span><ShieldCheck size={15} /><strong>{t("Held leases")}</strong></span>
        <small>{leases.length}</small>
      </div>
      <RuntimeProtocolList
        emptyLabel={t("No held leases")}
        items={leases.slice(0, 6)}
        renderItem={(lease) => <RuntimeResourceLeaseRow key={lease.id} lease={lease} />}
      />

      <div className="task-strip-head">
        <span><SlidersHorizontal size={15} /><strong>{t("Semaphores")}</strong></span>
        <small>{semaphoreSlots.length}</small>
      </div>
      <RuntimeProtocolList
        emptyLabel={t("No semaphore slots")}
        items={semaphoreSlots.slice(0, 6)}
        renderItem={(slot) => (
          <div className="runtime-diagnostics-row runtime-resource-row" key={slot.id}>
            <span className="runtime-diagnostics-copy">
              <strong>{slot.resourceType}: {truncatePreview(slot.resourceKey, 42)}</strong>
              <small>{slot.workUnitId} · {t("renewed")} {formatAge(slot.lastRenewedAt)}</small>
            </span>
            <RuntimeStatus status={runtimeSemaphoreStatusPresentation(slot.status)} />
          </div>
        )}
      />
    </section>
  );
}

function WorkUnitDiagnosticsRow({
  workUnit,
  busy,
  onCancel,
  onRetry,
  onReconcile,
}: {
  readonly workUnit: WorkUnit;
  readonly busy: boolean;
  readonly onCancel: (workUnitId: string) => void;
  readonly onRetry: (workUnitId: string) => void;
  readonly onReconcile: (workUnitId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const canCancel = ["queued", "claimed", "running", "waiting_for_approval"].includes(workUnit.status);
  const canRetry = workUnit.status === "failed" || workUnit.status === "stale";
  const canReconcile = ["claimed", "running", "waiting_for_approval", "cancelling", "stale"].includes(workUnit.status);
  const status = workUnitStatusPresentation(workUnit.status);
  return (
    <div className="runtime-diagnostics-row runtime-work-unit-row" aria-busy={busy || undefined}>
      <span className="runtime-diagnostics-copy">
        <strong>{workUnit.kind} · {workUnit.id}</strong>
        <small>
          {workUnit.ownerType}:{workUnit.ownerId}
          {workUnit.linkedRunId ? ` · run:${workUnit.linkedRunId}` : ""}
        </small>
        <small>
          {t("Last event")} {formatAge(workUnit.lastEventAt)}
          {" · "}
          {t("Last heartbeat")} {formatAge(workUnit.lastHeartbeatAt)}
        </small>
        {workUnit.errorMessage ? <small className="error-text">{workUnit.errorMessage}</small> : null}
      </span>
      <RuntimeStatus status={status} />
      <div className="runtime-diagnostics-actions">
        {canCancel ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onCancel(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <X size={13} />}
            {t("Cancel")}
          </button>
        ) : null}
        {canRetry ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onRetry(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
            {t("Retry")}
          </button>
        ) : null}
        {canReconcile ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onReconcile(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <FileCheck2 size={13} />}
            {t("Reconcile")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RuntimeResourceLeaseRow({ lease }: { readonly lease: ResourceLease }): React.JSX.Element {
  const { t } = useI18n();
  const status = resourceLeaseStatusPresentation(lease.status);
  return (
    <div className="runtime-diagnostics-row runtime-resource-row">
      <span className="runtime-diagnostics-copy">
        <strong>{lease.resourceType}: {truncatePreview(lease.resourceKey, 42)}</strong>
        <small>{lease.workUnitId ?? lease.ownerId} · {t("renewed")} {formatAge(lease.lastRenewedAt ?? lease.acquiredAt)}</small>
      </span>
      <RuntimeStatus status={status} />
    </div>
  );
}

function RuntimeStatus({
  status,
}: {
  readonly status: ReturnType<typeof workUnitStatusPresentation>;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <StatusIndicator
      className="runtime-diagnostics-status"
      label={t(status.labelKey)}
      tone={status.tone}
    />
  );
}

function RuntimeProtocolList<T>({
  emptyLabel,
  items,
  renderItem,
}: {
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => React.JSX.Element;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="client-empty-state compact">
        <FileText />
        <span>{emptyLabel}</span>
      </div>
    );
  }
  return <div className="runtime-diagnostics-list">{items.map(renderItem)}</div>;
}

function isActiveWorkUnit(workUnit: WorkUnit): boolean {
  return ["claimed", "running", "waiting_for_approval", "cancelling"].includes(workUnit.status);
}

function uniqueWorkUnits(workUnits: readonly WorkUnit[]): readonly WorkUnit[] {
  const byId = new Map<string, WorkUnit>();
  for (const unit of workUnits) {
    byId.set(unit.id, unit);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function formatAge(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}
