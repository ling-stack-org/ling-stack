import { Brain, Info } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, EmptyState, IconButton, StatusIndicator } from "../../shared/ui/index.js";
import type { TeammateMemoryDetail, TeammateMemoryScopeRow } from "./teammate-memory-view-models.js";

export function TeammateMemoryScopeList({
  rows,
  onOpenDetail,
}: {
  readonly rows: readonly TeammateMemoryScopeRow[];
  readonly onOpenDetail: (detail: TeammateMemoryDetail) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-memory-section" aria-labelledby="teammate-memory-scopes-title">
      <div className="teammate-memory-section-heading">
        <h3 id="teammate-memory-scopes-title">{t("Teammate scopes")}</h3>
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={<Brain />} title={t("Memory scopes are being prepared")} />
      ) : (
        <div className="teammate-memory-scope-list" data-ui2-teammate-memory-scope-list="true" role="list">
          {rows.map((row) => (
            <DataRow
              key={row.scope.id}
              className="teammate-memory-scope-row"
              compact
              role="listitem"
              data-memory-scope-id={row.scope.id}
              identity={(
                <span className="teammate-memory-row-copy">
                  <strong>{row.title}</strong>
                  {row.scope.channelId ? <small>{row.summary}</small> : null}
                </span>
              )}
              status={<StatusIndicator compact label={row.statusLabel} tone={row.tone} />}
              actions={(
                <IconButton
                  icon={Info}
                  label={t("View memory scope details")}
                  onClick={() => onOpenDetail({ kind: "scope", scope: row.scope })}
                />
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}
