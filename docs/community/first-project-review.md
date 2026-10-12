# Try a first project review

Use two AI teammates to review one small project brief, then compare their responses
in the same channel. This trial uses public sample text and asks for discussion only.
It does not require shell access, file changes, Office, or Computer Use.

## Start with one working model

Follow [Getting started](../getting-started.md) to start the Web UI and daemon from
source. In **Settings → Model Workbench**, configure your own chat model and run
**Check**. Confirm a normal conversation returns a final response before adding
teammates. Model checks and replies use your provider account and may incur charges.

Ling stores workspace state and history locally. The prompt and its context go to
the providers you choose. This trial is not an offline-inference demonstration.

## Set up the review

1. Copy the [sample project brief](../../examples/project-review/README.md) into a
   disposable local folder. Keep private code, credentials, and real customer data
   out of this first trial.
2. In **Settings → Teammate Management**, configure two teammates. Give one a
   requirements-review role and the other an acceptance-review role. Bind each to a
   checked chat model; they can share a model for this trial, or use different models.
   A role or skill does not grant tools or file permission.
3. Open **Channels**, create a project channel called **Project review**, select the
   disposable folder, choose a checked Ling Agent model, and add both teammates.
4. Paste the brief into a message. Select a teammate through the channel's mention
   picker when asking for that teammate's review. Ask for discussion only;
   this first trial does not ask the agents to execute work or modify files.

Start with this prompt for the requirements reviewer:

```text
Review the sample project brief below. Identify up to three missing requirements
that need a decision before implementation. Explain why each affects the first
version. Keep the scope small; do not implement anything or change files.

[Paste the Team Notes sample brief here.]
```

Wait for the requirements reviewer's final response. Then mention the acceptance
reviewer through the picker in the same channel:

```text
Review the sample brief and the requirements review above. Propose three concrete
acceptance checks for the first version. Separate required decisions from optional
improvements. Do not implement anything or change files.
```

Wait for the acceptance reviewer's final response. Finally ask the Ling Agent to
summarize the two reviews, without mentioning either teammate:

```text
Summarize the reviews in this channel as a short decision list: decisions needed
before implementation, three acceptance checks, and improvements that can wait.
Use the actual reviews; do not claim any code was changed or tested.
```

## Check the result

- Both requested teammates have a final response in the channel.
- The acceptance checks describe observable outcomes rather than general advice.
- The summary references the reviews and separates required decisions from later work.
- No file changes or execution are reported for this discussion-only trial.

This is an initial collaboration check, not a benchmark of model quality or an
acceptance test for tool execution. Responses vary by provider and model. For later
tasks that need tools, review tool bindings, workspace permissions, and approval
requests first; then inspect actual artifacts and execution evidence.

## Tell us where it gets stuck

Use the [Issue forms](https://github.com/ling-stack-org/ling-stack/issues/new/choose)
and include your version or commit, OS, the first failing step, and a minimal
reproduction. Share redacted errors only. Say whether you completed the review and
which part of the result was useful; do not upload keys or workspace databases.

## 中文快速说明

先按[入门指南](../getting-started.md)启动 Web 和 daemon，配置自己的聊天模型并通过
**Check**，确认普通对话能获得最终回复。模型检查和回复可能产生供应商费用。

把[示例项目说明](../../examples/project-review/README.md)复制到一个临时目录。
在 **Settings → Teammate Management** 配置两个队友，分别负责需求边界和验收条件，
绑定检查通过的模型；然后在 **Channels** 创建项目频道并加入两个队友。

第一次只做讨论：粘贴示例文本，通过频道的成员提及选择器依次请两位队友评审，
等需求队友最终回复后再提及验收队友，等验收队友最终回复后，清除队友提及，
请 Ling Agent 汇总“实施前需要决定的事项、三个可观察的验收条件、可后置的改进”。
可以使用同一个模型，也可以分别配置模型；不需要开放 shell 或文件修改权限。

完成标准是两位队友均返回最终意见、汇总能对应实际评审，并且没有宣称修改或测试代码。
本地保存的是状态和历史，任务上下文仍会发送到你选定的供应商。把卡住的步骤和结果是否
有用反馈到 Issue 即可；源码 Alpha、讨论演示与原生工具验收是不同范围。
