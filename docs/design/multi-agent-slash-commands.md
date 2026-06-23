# Multi-Agent Slash Commands

## Purpose

Ling should support Codex-like slash commands in the channel composer without turning commands into prompt folklore. The command parser is a local control-plane boundary: it recognizes a small grammar, resolves known commands against a registry, and dispatches structured actions. The model may see the resulting task prompt later, but it does not decide whether `/review` is a command.

This design adapts that principle to Ling's multi-agent workspace. Ling has channels, AI teammates, skill bindings, task records, and the existing `requestedSkillId` / `selectedSkillId` run path. Slash commands should reuse those primitives instead of introducing a parallel execution protocol.

## Grammar

Supported v1 forms:

- `/cmd args`: global command for the current channel.
- `@agent /cmd args`: agent-scoped command for one teammate.
- `@agentA @agentB /cmd args`: create the same command-backed task for each resolved teammate.
- `@agent normal message`: unchanged; this remains a directed chat message.

Deferred forms:

- `/cmd @agent args`: not a supported targeting form in v1.
- Natural-language command inference without a slash is handled by existing channel intent routing, not this parser.

## Ambiguity Rules

The parser only emits an intent when all of these are true:

- the command appears at the start of the composer text after trimming whitespace;
- the command token matches a registered command id or label;
- the command token is followed by whitespace or end-of-input;
- an `@agent` prefix, when present, resolves to a known teammate mention.

These inputs must not be treated as slash commands:

- absolute local paths such as `/Users/tianxiao/project` or `/tmp/file`;
- relative paths such as `./src`, `../docs`;
- URL paths and ordinary prose containing `/segment`;
- unknown commands such as `/not-a-real-command`.

This means `/review apps/web` can be a command, while `/review/apps/web` remains text/path-like input.

## Intent Model

The web composer parses into:

```ts
type ComposerSlashIntent =
  | { kind: "none" }
  | { kind: "global_command"; commandId: string; commandLabel: string; args: string; raw: string }
  | {
      kind: "agent_command";
      teammateId: string;
      teammateLabel: string;
      commandId: string;
      commandLabel: string;
      args: string;
      raw: string;
    }
  | {
      kind: "multi_agent_command";
      teammates: readonly { id: string; label: string }[];
      commandId: string;
      commandLabel: string;
      args: string;
      raw: string;
    };
```

`raw` preserves the user's command text for audit and future UI affordances. `args` is the remainder after the command token. The parser does not resolve permissions, tools, provider readiness, or effective skill eligibility.

## Dispatch

v1 maps skill commands to tasks:

- command registry source: built-in gstack skill pack plus active current-workspace Skill Library entries (`builtin` or `published`, workspace-visible);
- `/review args`: create a task in the selected channel with `requestedSkillId: "review"` and the channel default teammate as assignee when available;
- `@Engineer /review args`: create a task in the selected channel with `requestedSkillId: "review"` and `assigneeTeammateId` set to the resolved teammate;
- `@Engineer @QA /review args`: create one task per resolved teammate, each with the same prompt, `requestedSkillId`, and channel attachments;
- empty args produce a task prompt that asks the requested skill to use the current channel context.

Slash tasks may include current channel attachments. The task record stores `attachmentIds` so task creation remains auditable and the task detail view can surface the linked files. Attachments must already belong to the selected channel. Link previews remain channel-message assets and are not part of slash task creation in this slice.

The task-run runner contract remains unchanged. `PiRunnerTask` still receives only the task id, title, prompt, and channel id. Before creating the runner request, the daemon materializes `task.attachmentIds` through the existing channel attachment materialization pipeline and appends a bounded `Task attachments:` section to the prompt passed to the runner. The durable task prompt remains the user's original slash command prompt; the run snapshot records the expanded prompt used for execution.

When a task is run, the daemon resolves `task.assigneeTeammateId ?? channel.defaultTeammateId`, validates the requested skill against the teammate's effective skill bindings, checks provider/tool constraints, records `selectedSkillId` only after successful selection, and then executes the prompt augmented with task attachments when available.

Future command families can reuse the same parser but dispatch differently:

- local UI commands: open settings, switch panels, focus views;
- task/run commands: create task, start run, enqueue follow-up;
- governance commands: open approval, skill, or memory review surfaces.

## Permissions And Audit

Slash parsing does not grant capability. It only converts known syntax into a structured request. Destructive commands, tool use, provider access, and skill eligibility still flow through existing task/run approval and effective skill checks.

The durable v1 audit object is the created task: its prompt, assignee, `requestedSkillId`, and `attachmentIds` are stored in the existing task model. A future richer audit field can persist the original slash intent if we add command-specific history or UI chips.

## Implementation Slice

The first implementation slice is deliberately narrow:

1. add a pure composer parser for slash intents;
2. register built-in skill ids and current workspace published Skill Library entries as slash commands in the workspace composer;
3. create task(s) for `/skill args`, `@agent /skill args`, and `@agentA @agentB /skill args`;
4. leave normal chat mention behavior untouched;
5. persist channel attachment ids on slash-created tasks;
6. show a composer command picker for `/` and `@agent /` prefixes, and show a structured command chip once the draft resolves to a slash intent.

Open follow-up decisions:

- whether private teammate-owned skills should be available through `@agent /cmd` without becoming workspace-visible;
- whether task records should store the original `ComposerSlashIntent` as first-class metadata.
