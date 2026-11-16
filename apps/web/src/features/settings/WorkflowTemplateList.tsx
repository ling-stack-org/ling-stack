import { useState } from "react";
import type { WorkflowTemplateRegistryEntry } from "@ling-stack/contracts";
import { ArrowRight, Search } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Input, Select, Skeleton } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function WorkflowTemplateList({ entries, loading, disabled, onSelect, t }: {
  readonly entries: readonly WorkflowTemplateRegistryEntry[];
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onSelect: (entry: WorkflowTemplateRegistryEntry) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const rows = entries.filter((entry) => (status === "all" || entry.reviewStatus === status)
    && entry.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <div className="workflow-template-list">
      <div className="workflow-template-list-filters">
        <Input aria-label={t("Search workflow templates")} prefix={<Search size={14} />} value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
        <Select aria-label={t("Filter template status")} value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="all">{t("All statuses")}</option>
          {(["draft", "published", "disabled", "archived", "builtin"] as const).map((value) => <option key={value} value={value}>{t(workflowTemplateStatusLabel(value))}</option>)}
        </Select>
      </div>
      {loading && !entries.length ? (
        <div className="workflow-template-stack" role="status" aria-label={t("Loading workflow templates")}>
          {[0, 1, 2].map((index) => <Skeleton key={index} shape="block" height={64} width="100%" />)}
        </div>
      ) : !rows.length ? (
        <EmptyState compact title={t(entries.length ? "No matching workflow templates" : "No workflow templates")} />
      ) : (
        <ul className="workflow-template-rows" aria-label={t("Workflow templates")}>
          {rows.map((entry) => (
            <li key={entry.id} className="workflow-template-row">
              <div className="workflow-template-row-name">
                <Button className="workflow-template-name-button" size="sm" variant="ghost" disabled={disabled} onClick={() => onSelect(entry)}>{entry.id}</Button>
                <small>{t("Version {version}", { version: entry.latestVersion })} <span>{entry.source}</span></small>
              </div>
              <Badge tone={entry.reviewStatus === "published" || entry.reviewStatus === "builtin" ? "success" : entry.reviewStatus === "disabled" ? "warning" : "neutral"}>
                {t(workflowTemplateStatusLabel(entry.reviewStatus))}
              </Badge>
              <IconButton icon={ArrowRight} label={t("Open template {id}", { id: entry.id })} disabled={disabled} onClick={() => onSelect(entry)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function workflowTemplateStatusLabel(status: string): string {
  switch (status) {
    case "draft": return "Draft";
    case "published": return "Published";
    case "disabled": return "Disabled";
    case "archived": return "Archived";
    case "builtin": return "Built-in";
    default: return status;
  }
}
