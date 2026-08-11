import { Search, Timer, X } from "lucide-react";
import {
  EmptyState,
  IconButton,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../../shared/ui/index.js";
import type { AutomationDraftMutationKind, AutomationMutationKind } from "../../domains/automations/use-automations-domain.js";
import type { AutomationStatus } from "../../types.js";
import { AutomationDefinitionRow } from "./AutomationDefinitionRow.js";
import { AutomationDraftList } from "./AutomationDraftList.js";
import { AutomationRunList } from "./AutomationRunList.js";
import type {
  AutomationDefinitionViewModel,
  AutomationDraftViewModel,
  AutomationRunViewModel,
  AutomationTab,
  AutomationTabItem,
  AutomationTranslate,
} from "./automation-view-models.js";

export function AutomationListPane({
  activeTab,
  automationActionById,
  automationErrorById,
  definitions,
  draftActionById,
  draftErrorById,
  drafts,
  loading,
  runs,
  search,
  selectedAutomationId,
  selectedDraftId,
  tabs,
  t,
  onArchive,
  onConfirmDraft,
  onDiscardDraft,
  onOpenRun,
  onOpenSchedule,
  onOpenThread,
  onRun,
  onSearchChange,
  onSelectAutomation,
  onSelectDraft,
  onStatusChange,
  onTabChange,
}: {
  readonly activeTab: AutomationTab;
  readonly automationActionById: Readonly<Record<string, AutomationMutationKind | undefined>>;
  readonly automationErrorById: Readonly<Record<string, string | undefined>>;
  readonly definitions: readonly AutomationDefinitionViewModel[];
  readonly draftActionById: Readonly<Record<string, AutomationDraftMutationKind | undefined>>;
  readonly draftErrorById: Readonly<Record<string, string | undefined>>;
  readonly drafts: readonly AutomationDraftViewModel[];
  readonly loading: boolean;
  readonly runs: readonly AutomationRunViewModel[];
  readonly search: string;
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly tabs: readonly AutomationTabItem[];
  readonly t: AutomationTranslate;
  readonly onArchive: (automationId: string) => void;
  readonly onConfirmDraft: (draftId: string) => void;
  readonly onDiscardDraft: (draftId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenSchedule: (automationId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onRun: (automationId: string) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onSelectAutomation: (automationId: string) => void;
  readonly onSelectDraft: (draftId: string) => void;
  readonly onStatusChange: (automationId: string, status: AutomationStatus) => void;
  readonly onTabChange: (tab: AutomationTab) => void;
}): React.JSX.Element {
  const hasContent = activeTab === "history" ? runs.length > 0 : definitions.length > 0 || drafts.length > 0;
  return (
    <section className="automation-current-pane automation-ui2-list-pane" aria-label={t("Enabled automations")} data-automation-list-pane>
      <div className="automation-ui2-toolbar">
        <Input
          aria-label={t("Search")}
          containerClassName="automation-ui2-search"
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search) {
              event.preventDefault();
              onSearchChange("");
            }
          }}
          placeholder={t("Search")}
          prefix={<Search aria-hidden="true" size={15} />}
          suffix={search ? (
            <IconButton
              icon={X}
              label={t("Clear search")}
              onClick={() => onSearchChange("")}
              tooltip=""
            />
          ) : undefined}
          value={search}
        />
        <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as AutomationTab)}>
          <TabsList className="automation-tab-list" aria-label={t("Automation status")} appearance="contained" size="sm">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <span>{tab.label}</span>
                {tab.count > 0 ? <span className="automation-ui2-tab-count">{tab.count}</span> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="automation-ui2-scroll-region" data-automation-scroll-region>
        {loading ? <AutomationListSkeleton /> : hasContent ? (
          <>
            {activeTab === "history" ? (
              <AutomationRunList runs={runs} t={t} onOpenRun={onOpenRun} />
            ) : (
              <div className="automation-ui2-definition-list" role="listbox" aria-label={t("Automations")}>
                {definitions.map((definition) => (
                  <AutomationDefinitionRow
                    key={definition.automation.id}
                    action={automationActionById[definition.automation.id]}
                    error={automationErrorById[definition.automation.id] ?? ""}
                    selected={selectedAutomationId === definition.automation.id}
                    t={t}
                    viewModel={definition}
                    onArchive={onArchive}
                    onOpenRun={onOpenRun}
                    onOpenSchedule={onOpenSchedule}
                    onOpenThread={onOpenThread}
                    onRun={onRun}
                    onSelect={onSelectAutomation}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </div>
            )}
            {activeTab === "attention" && drafts.length > 0 ? (
              <AutomationDraftList
                actionById={draftActionById}
                drafts={drafts}
                errorById={draftErrorById}
                selectedDraftId={selectedDraftId}
                t={t}
                onConfirm={onConfirmDraft}
                onDiscard={onDiscardDraft}
                onSelect={onSelectDraft}
              />
            ) : null}
          </>
        ) : (
          <EmptyState
            className="automation-ui2-empty"
            compact
            icon={search ? <Search size={18} /> : <Timer size={18} />}
            title={activeTab === "history" ? t("No runs yet") : t("No automations yet")}
          />
        )}
      </div>
    </section>
  );
}

function AutomationListSkeleton(): React.JSX.Element {
  return (
    <div className="automation-ui2-list-skeleton" aria-label="Loading" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="automation-ui2-skeleton-row">
          <Skeleton height="14px" width="34%" />
          <Skeleton height="12px" width="48%" />
        </div>
      ))}
    </div>
  );
}
