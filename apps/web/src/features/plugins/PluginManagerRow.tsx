import { Plug } from "lucide-react";
import { StatusIndicator, TableCell, TableRow } from "../../shared/ui/index.js";
import type { PluginActionHandlers, PluginRowView } from "./plugin-manager-types.js";
import { PluginRowActions } from "./PluginRowActions.js";
import type { Translate } from "../../i18n.js";

export function PluginManagerRow({
  row,
  handlers,
  t,
}: {
  readonly row: PluginRowView;
  readonly handlers: PluginActionHandlers;
  readonly t: Translate;
}): React.JSX.Element {
  return (
    <TableRow className="plugin-table-row" data-plugin-id={row.id} data-primary-state={row.primaryState.id}>
      <TableCell className="plugin-table-name">
        <Plug aria-hidden="true" />
        <span className="plugin-table-name-copy">
          <strong title={row.name}>{row.name}</strong>
          {row.actionFailure ? (
            <small className="plugin-table-action-failure" role="alert" title={row.actionFailure.detail}>
              {row.actionFailure.message}
            </small>
          ) : row.description ? <small title={row.description}>{row.description}</small> : null}
        </span>
      </TableCell>
      <TableCell className="plugin-table-source" data-plugin-column="source">
        <span title={row.sourceLabel}>{row.sourceLabel}</span>
      </TableCell>
      <TableCell className="plugin-table-status-cell">
        <StatusIndicator
          className="plugin-table-status"
          label={row.primaryState.label}
          tone={row.primaryState.tone}
        />
      </TableCell>
      <TableCell className="plugin-table-actions-cell">
        <PluginRowActions handlers={handlers} row={row} t={t} />
      </TableCell>
    </TableRow>
  );
}
