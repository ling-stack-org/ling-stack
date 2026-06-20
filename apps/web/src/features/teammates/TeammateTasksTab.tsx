import { Loader2, Plus, SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { AiTeammate, Channel, EffectiveTeammateSkill, Task } from "../../types.js";
import { TeammateListSection } from "./TeammateListSection.js";

export interface TeammateTaskCreateForm {
  readonly channelId: string;
  readonly requestedSkillId: string;
  readonly title: string;
  readonly prompt: string;
}

export function TeammateTasksTab({
  teammate,
  taskForm,
  taskMessage,
  taskChannelOptions,
  executableSkillOptions,
  tasks,
  creatingTask,
  onTaskFormChange,
  onCreateTask,
}: {
  readonly teammate: AiTeammate;
  readonly taskForm: TeammateTaskCreateForm;
  readonly taskMessage: string;
  readonly taskChannelOptions: readonly Channel[];
  readonly executableSkillOptions: readonly EffectiveTeammateSkill[];
  readonly tasks: readonly Task[];
  readonly creatingTask: boolean;
  readonly onTaskFormChange: (form: TeammateTaskCreateForm) => void;
  readonly onCreateTask: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <section className="teammate-list-panel teammate-task-create-panel" aria-label={t("New teammate task")}>
        <div className="panel-title split">
          <span>
            <SquareTerminal size={16} />
            <h2>{t("New teammate task")}</h2>
          </span>
          {taskMessage ? <small>{taskMessage}</small> : null}
        </div>
        <div className="teammate-task-create-grid">
          <label className="field">
            <span>{t("Task channel")}</span>
            <select
              value={taskForm.channelId}
              onChange={(event) => onTaskFormChange({ ...taskForm, channelId: event.target.value })}
              disabled={taskChannelOptions.length === 0}
            >
              {taskChannelOptions.length === 0 ? <option value="">{t("No channels available")}</option> : null}
              {taskChannelOptions.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("Task title")}</span>
            <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
          </label>
          <label className="field">
            <span>{t("Requested skill")}</span>
            <select
              value={taskForm.requestedSkillId}
              onChange={(event) => onTaskFormChange({ ...taskForm, requestedSkillId: event.target.value })}
            >
              <option value="">{t("None")}</option>
              {executableSkillOptions.map((skill) => (
                <option key={skill.skillId} value={skill.skillId}>
                  {t(skill.skill.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            <span>{t("Task prompt")}</span>
            <textarea rows={5} value={taskForm.prompt} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
          </label>
        </div>
        <div className="teammate-task-create-footer">
          <span className="phase-token implement">{t("Assigned to {name}", { name: teammate.displayName })}</span>
          {taskForm.requestedSkillId ? <span className="phase-token plan">{t("Skill {skill}", { skill: taskForm.requestedSkillId })}</span> : null}
          <button className="primary-button" type="button" onClick={() => void onCreateTask()} disabled={creatingTask || !taskForm.prompt.trim() || taskChannelOptions.length === 0}>
            {creatingTask ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
            {t("Create task")}
          </button>
        </div>
      </section>
      <TeammateListSection
        icon={<SquareTerminal size={16} />}
        title={t("Tasks")}
        emptyLabel={t("No tasks assigned to this teammate")}
        items={tasks}
        renderItem={(task) => (
          <article key={task.id} className="teammate-data-row">
            <span>
              <strong>{task.title}</strong>
              <small>
                {task.prompt}
                {task.requestedSkillId ? ` · ${t("Requested skill")}: ${task.requestedSkillId}` : ""}
              </small>
            </span>
            <StatusBadge status={task.status} />
          </article>
        )}
      />
    </>
  );
}
