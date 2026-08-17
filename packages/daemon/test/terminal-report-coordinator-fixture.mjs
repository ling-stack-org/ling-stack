import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
export function createTerminalWorkflowFixture(store, cwd, suffix = "default") {
  const now = "2026-07-11T05:00:00.000Z";
  const channel = store.createChannel({ name: `Terminal report ${suffix}`, boundPath: cwd }, now);
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body: "实现 TerminalReport",
  }, now);
  const sourceItem = store.getConversationItem(sourceMessage.id);
  if (!sourceItem?.turnId) throw new Error(`Terminal report fixture source Item has no Turn: ${sourceMessage.id}`);
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "实现 TerminalReport",
    objective: "实现 TerminalReport 并完成验证",
    status: "succeeded",
    createdBy: "ling_agent",
    metadata: { sourceMessageId: sourceMessage.id, sourceTurnId: sourceItem.turnId, responseLanguage: "zh-CN" },
  }, "2026-07-11T05:01:00.000Z");
  const engineer = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "实现持久化",
    prompt: "Implement persistence.",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    status: "succeeded",
  }, "2026-07-11T05:02:00.000Z");
  const engineerTask = store.createTask({
    channelId: channel.id,
    title: "实现持久化",
    prompt: "Implement persistence.",
    assigneeTeammateId: "engineer",
  }, "2026-07-11T05:02:00.000Z");
  const engineerRun = createFixtureRun(store, {
    id: `run_terminal_fixture_${suffix}_engineer`,
    cwd,
    channelId: channel.id,
    taskId: engineerTask.id,
    teammateId: "engineer",
    workflowStepId: engineer.id,
    summary: "完成 SQLite 持久化和幂等提交。",
    createdAt: "2026-07-11T05:02:00.000Z",
  });
  store.updateChannelWorkflowStep(engineer.id, {
    taskId: engineerTask.id,
    runId: engineerRun.id,
    resultSummary: "完成 SQLite 持久化和幂等提交。",
  }, "2026-07-11T05:02:30.000Z");
  const qa = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "验证实现",
    prompt: "Verify implementation.",
    toParticipantId: "qa",
    toParticipantLabel: "QA",
    status: "succeeded",
  }, "2026-07-11T05:03:00.000Z");
  const qaTask = store.createTask({
    channelId: channel.id,
    title: "验证实现",
    prompt: "Verify implementation.",
    assigneeTeammateId: "qa",
  }, "2026-07-11T05:03:00.000Z");
  const qaRun = createFixtureRun(store, {
    id: `run_terminal_fixture_${suffix}_qa`,
    cwd,
    channelId: channel.id,
    taskId: qaTask.id,
    teammateId: "qa",
    workflowStepId: qa.id,
    summary: "Core 和 Daemon 测试通过。",
    createdAt: "2026-07-11T05:03:00.000Z",
  });
  store.updateChannelWorkflowStep(qa.id, {
    taskId: qaTask.id,
    runId: qaRun.id,
    resultSummary: "Core 和 Daemon 测试通过。",
  }, "2026-07-11T05:03:30.000Z");
  return { channel, sourceMessage, workflow, engineer, engineerRun, qa, qaRun };
}

function createFixtureRun(store, input) {
  const run = store.createRun({
    id: input.id,
    cwd: input.cwd,
    taskId: input.taskId,
    channelId: input.channelId,
    teammateId: input.teammateId,
    workflowStepId: input.workflowStepId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: input.taskId, title: input.summary },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd: input.cwd, responseLanguage: "zh-CN" },
    createdAt: input.createdAt,
  });
  store.markRunStarted(run.id, input.createdAt);
  store.appendEvent(run.id, "assistant_text_delta", { text: input.summary });
  store.markRunSucceeded(run.id, input.createdAt);
  return store.getRun(run.id);
}
