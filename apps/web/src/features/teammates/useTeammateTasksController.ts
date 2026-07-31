import { useEffect, useMemo, useRef, useState } from "react";
import { createTask } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { titleFromPrompt } from "../../lib/formatting.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  AiTeammate,
  Channel,
  Task,
  TeammateChannelMembership,
  TeammateDirectMessage,
} from "../../types.js";
import {
  deriveActiveTeammateTaskChannels,
  resolveTeammateTaskChannelId,
} from "./teammate-task-creation.js";

export function useTeammateTasksController({
  cwd,
  teammate,
  channels,
  memberships,
  onOpenTask,
  onTaskCreated,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly channels: readonly Channel[];
  readonly memberships: readonly TeammateChannelMembership[];
  readonly onOpenTask?: (task: Task) => void;
  readonly onTaskCreated?: (task: Task) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammate.id}`;
  const identityRef = useRef(identityKey);
  const busyKeysRef = useRef(new Set<string>());
  const feedbackToastIdRef = useRef("");
  identityRef.current = identityKey;

  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [messageErrors, setMessageErrors] = useState<Readonly<Record<string, string>>>({});
  const taskChannels = useMemo(
    () => deriveActiveTeammateTaskChannels(channels, memberships),
    [channels, memberships],
  );

  useEffect(() => {
    busyKeysRef.current = new Set();
    setBusyKeys(new Set());
    setMessageErrors({});
    if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = "";
  }, [dismissToast, identityKey]);

  async function createFromMessage(message: TeammateDirectMessage): Promise<void> {
    const workspaceCwd = cwd.trim();
    const channelId = resolveTeammateTaskChannelId("", taskChannels, memberships);
    const prompt = message.body.trim();
    const key = `message:${message.id}`;
    if (!workspaceCwd) {
      setMessageError(message.id, t("Workspace path is required."));
      return;
    }
    if (!channelId) {
      setMessageError(message.id, t("Join this teammate to an active channel before creating a task."));
      return;
    }
    if (!prompt || busyKeysRef.current.has(key)) return;

    const operationIdentity = identityRef.current;
    beginBusy(key);
    setMessageError(message.id, "");
    try {
      const response = await createTask(workspaceCwd, channelId, {
        title: titleFromPrompt(prompt),
        prompt,
        assigneeTeammateId: teammate.id,
      });
      if (identityRef.current !== operationIdentity) return;
      if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
      feedbackToastIdRef.current = showToast({
        message: t("Task created for {name}", { name: teammate.displayName }),
        scope: `teammate:tasks:${teammate.id}:create:${response.task.id}`,
        tone: "success",
        action: onOpenTask ? {
          altText: t("View task"),
          label: t("View task"),
          onSelect: () => onOpenTask(response.task),
        } : undefined,
      });
      void Promise.resolve(onTaskCreated?.(response.task)).catch(() => undefined);
    } catch {
      if (identityRef.current === operationIdentity) {
        setMessageError(message.id, t("Task could not be created. Try again."));
      }
    } finally {
      if (identityRef.current === operationIdentity) finishBusy(key);
    }
  }

  function setMessageError(messageId: string, message: string): void {
    setMessageErrors((current) => {
      if (!message && !(messageId in current)) return current;
      const next = { ...current };
      if (message) next[messageId] = message;
      else delete next[messageId];
      return next;
    });
  }

  function beginBusy(key: string): void {
    busyKeysRef.current = new Set([...busyKeysRef.current, key]);
    setBusyKeys(new Set(busyKeysRef.current));
  }

  function finishBusy(key: string): void {
    const next = new Set(busyKeysRef.current);
    next.delete(key);
    busyKeysRef.current = next;
    setBusyKeys(new Set(next));
  }

  return {
    busyKeys,
    messageErrors,
    taskChannels,
    createFromMessage,
  };
}
