import { Database, Send, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  Button,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import type { Channel, ProviderPreset, TaskFormState } from "../../types.js";
import { ProviderPresetOptions } from "./WorkspaceControls.js";

export function NewTaskPanel({
  taskForm,
  selectedChannel,
  effectiveProviderId,
  taskReadyProviders,
  setupChatProviders,
  mediaProviders,
  providersLoading,
  error,
  onProviderSelect,
  onTaskFormChange,
  onCreateTask,
  onCancel,
}: {
  readonly taskForm: TaskFormState;
  readonly selectedChannel: Channel | undefined;
  readonly effectiveProviderId: string;
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly mediaProviders: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly error?: string;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onCreateTask: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const allowedTools = selectedChannel?.allowedTools ?? defaultTools;

  return (
    <div className="channel-task-create-surface">
      <header className="channel-task-surface-header">
        <h2>{t("New task")}</h2>
        <Button size="sm" variant="ghost" leadingIcon={<X size={14} />} onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </header>

      <div className="channel-task-form">
        <Field label={t("Run provider")}>
          <Select
            size="md"
            value={effectiveProviderId}
            onChange={(event) => onProviderSelect(event.target.value)}
            disabled={providersLoading}
          >
            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </Select>
        </Field>
        <Field label={t("Title")}>
          <Input
            value={taskForm.title}
            onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })}
          />
        </Field>
        <Field label={t("Prompt")} required>
          <Textarea
            value={taskForm.prompt}
            rows={7}
            onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })}
          />
        </Field>
      </div>

      <InspectorSection
        className="channel-task-execution-context"
        title={t("Execution context")}
        summary={t("{count} tools", { count: allowedTools.length })}
      >
        <div className="channel-task-tool-list" aria-label={t("Tool calls")}>
          {allowedTools.map((tool) => (
            <span key={tool} data-risky={riskyTools.includes(tool) || undefined}>{tool}</span>
          ))}
        </div>
        {mediaProviders.length > 0 ? (
          <InlineFeedback tone="info">
            <span className="channel-task-feedback-line">
              <Database size={14} />
              <span>{t("Generation-only models cannot run coding tasks.")}</span>
            </span>
          </InlineFeedback>
        ) : null}
      </InspectorSection>

      {error ? (
        <InlineFeedback tone="danger" role="alert">
          {error}
        </InlineFeedback>
      ) : null}

      <footer className="channel-task-surface-footer">
        <Button
          variant="primary"
          leadingIcon={<Send size={15} />}
          onClick={onCreateTask}
          disabled={!selectedChannel || !taskForm.prompt.trim()}
        >
          {t("Create task")}
        </Button>
      </footer>
    </div>
  );
}
