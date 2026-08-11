import { Plug } from "lucide-react";
import {
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../shared/ui/index.js";
import type { PluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionHandlers, PluginRowView } from "./plugin-manager-types.js";
import { PluginManagerRow } from "./PluginManagerRow.js";
import type { Translate } from "../../i18n.js";

export function PluginManagerTable({
  allRows,
  rows,
  isLoading,
  hasActiveFilters,
  copy,
  handlers,
  onAdd,
  onClearFilters,
  t,
}: {
  readonly allRows: readonly PluginRowView[];
  readonly rows: readonly PluginRowView[];
  readonly isLoading: boolean;
  readonly hasActiveFilters: boolean;
  readonly copy: PluginManagerCopy;
  readonly handlers: PluginActionHandlers;
  readonly onAdd: () => void;
  readonly onClearFilters: () => void;
  readonly t: Translate;
}): React.JSX.Element {
  const initialLoading = isLoading && allRows.length === 0;
  return (
    <TableContainer className="plugin-table" data-refreshing={isLoading && allRows.length > 0 ? "true" : undefined}>
      <Table aria-label={t("Plugins")} className="plugin-table-grid">
        <TableHead className="plugin-table-header">
          <TableRow>
            <TableHeaderCell>{t("Plugin")}</TableHeaderCell>
            <TableHeaderCell aria-hidden="true" className="plugin-table-source-header">{t("Source")}</TableHeaderCell>
            <TableHeaderCell>{t("Status")}</TableHeaderCell>
            <TableHeaderCell>{t("Actions")}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody className="plugin-table-body">
          {initialLoading ? <PluginSkeletonRows /> : rows.length ? rows.map((row) => (
            <PluginManagerRow key={row.id} handlers={handlers} row={row} t={t} />
          )) : (
            <TableRow className="plugin-table-empty-row">
              <TableCell colSpan={4}>
                <EmptyState
                  action={hasActiveFilters ? (
                    <Button onClick={onClearFilters} size="sm">{t("Clear filters")}</Button>
                  ) : (
                    <Button onClick={onAdd} size="sm" variant="primary">{t("Add plugin")}</Button>
                  )}
                  className="plugin-table-empty"
                  compact
                  icon={<Plug aria-hidden="true" />}
                  title={hasActiveFilters ? copy.noResults : t("No managed plugins registered")}
                />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function PluginSkeletonRows(): React.JSX.Element {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <TableRow className="plugin-table-row plugin-table-skeleton-row" key={index}>
          <TableCell><Skeleton height={14} width="68%" /></TableCell>
          <TableCell><Skeleton height={12} width="72%" /></TableCell>
          <TableCell><Skeleton height={12} width="68%" /></TableCell>
          <TableCell><Skeleton height={32} width={132} /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
