import { ExternalLink, Kanban, ListTodo, Plus, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  Button,
  DataRow,
  EmptyState,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  Select,
  Skeleton,
  StatusIndicator,
  Textarea,
} from "../../shared/ui/index.js";
import type { EffectiveTeammateSkill } from "../../types.js";
import type { TeammateTaskFilter, TeammateTaskRowViewModel } from "./teammate-tasks-view-models.js";
import type { TeammateTasksController } from "./useTeammateTasksController.js";

const taskFilters: readonly TeammateTaskFilter[] = ["all", "active", "attention", "completed"];

export function TeammateTasksTab({
  controller,
  skills,
  onOpenChannels,
}: {
  readonly controller: TeammateTasksController;
  readonly skills: readonly EffectiveTeammateSkill[];
  readonly onOpenChannels: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const {
    busyKeys,
    createOpen,
    filter,
    form,
    formError,
    loadError,
    loading,
    refreshing,
    rows,
    searchQuery,
    stale,
    stats,
    taskChannels,
    visibleRows,
  } = controller;

  return (
    <section className="teammate-tasks-panel" data-ui2-teammate-tasks="true" aria-label={t("Tasks")}>
      <header className="teammate-tasks-heading">
        <div>
          <ListTodo aria-hidden="true" />
          <h2>{t("Recent tasks")}</h2>
        </div>
        <StatusIndicator
          compact
          label={stats.attention > 0
            ? t("{count} need attention", { count: stats.attention })
            : t("{count} recent tasks", { count: stats.total })}
          tone={stats.attention > 0 ? "warning" : "neutral"}
        />
      </header>

      <div className="teammate-task-summary" aria-label={t("Task summary")}>
        <SummaryItem label={t("Active")} value={stats.active} />
        <SummaryItem label={t("Needs attention")} value={stats.attention} tone={stats.attention > 0 ? "warning" : "neutral"} />
        <SummaryItem label={t("Completed")} value={stats.completed} />
      </div>

      <div className="teammate-task-toolbar">
        <Input
          aria-label={t("Search tasks")}
          containerClassName="teammate-task-search"
          prefix={<Search aria-hidden="true" />}
          placeholder={t("Search tasks")}
          type="search"
          value={searchQuery}
          onChange={(event) => controller.setSearchQuery(event.target.value)}
        />
        <Select
          aria-label={t("Status")}
          className="teammate-task-filter"
          value={filter}
          onChange={(event) => controller.setFilter(event.target.value as TeammateTaskFilter)}
        >
          {taskFilters.map((item) => (
            <option key={item} value={item}>{t(taskFilterLabelKey(item))}</option>
          ))}
        </Select>
        <IconButton
          icon={RefreshCw}
          label={t("Refresh tasks")}
          loading={refreshing}
          disabled={loading}
          onClick={() => void controller.refresh("refresh")}
        />
        <Button leadingIcon={<Kanban />} size="sm" variant="secondary" onClick={controller.onOpenWorkBoard}>
          {t("Open Work Board")}
        </Button>
        <Button leadingIcon={<Plus />} size="sm" onClick={controller.toggleCreate}>
          {createOpen ? t("Hide task form") : t("Create task")}
        </Button>
      </div>

      {createOpen ? (
        <section className="teammate-task-create" data-ui2-teammate-task-create="true" aria-label={t("New teammate task")}>
          <div className="teammate-task-create-grid">
            <Field label={t("Task channel")} required>
              <Select
                disabled={taskChannels.length === 0}
                value={form.channelId}
                onChange={(event) => controller.updateForm({ ...form, channelId: event.target.value })}
              >
                {taskChannels.length === 0 ? <option value="">{t("No active channels")}</option> : null}
                {taskChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channel.name}</option>
                ))}
              </Select>
            </Field>
              <Field label={t("Requested skill")}>
                <Select
                  value={form.requestedSkillId}
                  onChange={(event) => controller.updateForm({ ...form, requestedSkillId: event.target.value })}
                >
                  <option value="">{t("None")}</option>
                  {skills.filter((skill) => skill.executable).map((skill) => (
                    <option key={skill.skillId} value={skill.skillId}>{t(skill.skill.name)}</option>
                  ))}
                </Select>
              </Field>
              <Field className="teammate-task-title-field" label={t("Task title")}>
                <Input
                  value={form.title}
                  onChange={(event) => controller.updateForm({ ...form, title: event.target.value })}
                />
              </Field>
              <Field className="teammate-task-prompt-field" label={t("Task prompt")} required>
                <Textarea
                  rows={4}
                  value={form.prompt}
                  onChange={(event) => controller.updateForm({ ...form, prompt: event.target.value })}
                />
              </Field>
          </div>
          {taskChannels.length === 0 ? (
            <div className="teammate-task-no-channel">
              <InlineFeedback tone="warning">
                {t("Join this teammate to an active channel before creating a task.")}
              </InlineFeedback>
              <Button size="sm" variant="secondary" onClick={onOpenChannels}>{t("Open Channels")}</Button>
            </div>
          ) : null}
          {formError ? <InlineFeedback className="teammate-task-create-error" tone="danger">{formError}</InlineFeedback> : null}
          <div className="teammate-task-create-actions">
            <Button size="sm" variant="ghost" disabled={busyKeys.has("form")} onClick={() => controller.setCreateOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              leadingIcon={<Plus />}
              size="sm"
              loading={busyKeys.has("form")}
              loadingLabel={t("Creating task")}
              disabled={taskChannels.length === 0 || !form.prompt.trim()}
              onClick={() => void controller.createFromForm()}
            >
              {t("Create task")}
            </Button>
          </div>
        </section>
      ) : null}

      {loadError ? (
        <div className="teammate-task-load-error">
          <InlineFeedback tone={stale ? "warning" : "danger"}>{loadError}</InlineFeedback>
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void controller.refresh("refresh")}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="teammate-task-loading" aria-label={t("Loading recent tasks")}>
          <Skeleton height={52} />
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-task-empty"
          icon={<ListTodo />}
          title={t("No tasks assigned to this teammate")}
          description={t("Create a task here or from a private message.")}
        />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          compact
          className="teammate-task-empty"
          icon={<Search />}
          title={t("No tasks match these filters")}
          action={<Button size="sm" variant="secondary" onClick={controller.clearFilters}>{t("Clear filters")}</Button>}
        />
      ) : (
        <div className="teammate-task-list" data-ui2-teammate-task-list="true" role="listbox" aria-label={t("Recent tasks")}>
          {visibleRows.map((row) => (
            <TaskRow key={row.task.id} row={row} onOpen={() => controller.onOpenTask?.(row.task)} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ row, onOpen }: { readonly row: TeammateTaskRowViewModel; readonly onOpen: () => void }): JSX.Element {
  const { t } = useI18n();
  const meta = [
    row.channelName,
    row.requestedSkillName ? t("Skill {skill}", { skill: row.requestedSkillName }) : undefined,
    formatDateTime(row.task.updatedAt),
  ].filter(Boolean).join(" · ");
  return (
    <DataRow
      compact
      className="teammate-task-row"
      data-task-id={row.task.id}
      role="option"
      onClick={onOpen}
      identity={(
        <span className="teammate-task-row-identity">
          <strong title={row.task.title}>{row.task.title}</strong>
          <small title={row.task.prompt}>{row.task.prompt}</small>
        </span>
      )}
      summary={<span className="teammate-task-row-meta" title={meta}>{meta}</span>}
      status={<StatusIndicator compact label={t(row.statusLabelKey)} tone={row.statusTone} />}
      actions={(
        <IconButton
          icon={ExternalLink}
          label={row.destination === "run" ? t("Open run") : t("Open in Work Board")}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        />
      )}
    />
  );
}

function SummaryItem({
  label,
  tone = "neutral",
  value,
}: {
  readonly label: string;
  readonly tone?: "neutral" | "warning";
  readonly value: number;
}): JSX.Element {
  return (
    <span data-tone={tone}>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function taskFilterLabelKey(filter: TeammateTaskFilter): string {
  if (filter === "active") return "Active tasks";
  if (filter === "attention") return "Needs attention";
  if (filter === "completed") return "Completed tasks";
  return "All tasks";
}
