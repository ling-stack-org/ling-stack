# Multi-Agent Slash Commands

Related docs:

- [Conversation Composer Unification](conversation-composer-unification.md)
- [Conversation Plan And Goal Modes](conversation-plan-and-goal-modes.md)
- [Ling Agent Session Control Plane](ling-agent-session.md)

## Purpose

Ling should support Codex-like slash commands in the channel composer without turning commands into prompt folklore. The command parser is a local control-plane boundary: it recognizes a small grammar, resolves known commands against a registry, and dispatches structured actions. The model may see the resulting task prompt later, but it does not decide whether `/review` is a command.

This design adapts that principle to Ling's multi-agent workspace. Ling has channels, AI teammates, skill bindings, task records, and the existing `requestedSkillId` / `selectedSkillId` run path. Slash commands should reuse those primitives instead of introducing a parallel execution protocol.

## Grammar

Supported v1 forms:

- `/cmd args`: global command for the current channel.
- `@agent /cmd args`: agent-scoped command for one teammate.
- `@agentA @agentB /cmd args`: create the same command-backed task for each resolved teammate.
- `@agent normal message`: unchanged; this remains a directed chat message.

`@agent` is resolved against known teammate labels and ids, not by splitting on a
single whitespace-free token. Display labels with spaces are valid, so
`@Ling Agent /review docs` is the same grammar as `@Engineer /review docs`.

Deferred forms:

- `/cmd @agent args`: not a supported targeting form in v1.
- arbitrary prose followed by ` /cmd`: not a structured command in v1; unlike Codex's
  generic command menu, Ling's v1 slash dispatch requires the command to be at the
  start of the composer text or immediately after resolved teammate mentions.
- Natural-language command inference without a slash is handled by existing channel intent routing, not this parser.

## Composer Token Model

The composer treats slash commands as UI control tokens, not plain prompt folklore. The
editable input remains the source of truth, and text-like structures should render as
inline tokens inside the composer text flow rather than as a separate strip above the
input:

- `text`: ordinary text that remains part of the message or task prompt;
- `agent_mention`: resolved `@agent` labels/ids, including display labels with spaces;
- `slash_command`: registered `/cmd` tokens selected or typed at a token boundary;
- `url_ref`: recognized web URLs or repository links;
- `file_ref`: workspace paths that should become message/task file references;
- `attachment`: uploaded channel assets.

Only a resolved `ComposerSlashIntent` is executable. Extra `slash_command` tokens later
in the draft are rendered as command references so the user can tell they are structured,
but they do not create additional tasks in v1.

The visual model follows Codex's input-box affordance: structured text appears in the
same line-wrapping region as the user's prose. A command token such as `/review`, a
GitHub repo URL, and an `@agent` mention should look like compact inline chips with an
icon and label, followed by the caret and any remaining plain text. They should not
create a large mode card or a detached preview row above the conversation input.

`attachment` is the exception. Binary objects that need thumbnails, upload progress, or
large remove controls may stay in the composer shell above the text flow. Text-like refs
do not use that attachment strip.

## Ambiguity Rules

The parser only emits an intent when all of these are true:

- the command appears at the start of the composer text after trimming whitespace;
- the command token matches a registered command id or label;
- the command token is followed by whitespace or end-of-input;
- an `@agent` prefix, when present, resolves to a known teammate mention by exact
  label/id or normalized label/id aliases.

These inputs must not be treated as slash commands:

- absolute local paths such as `/Users/example/project` or `/tmp/file`;
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

## Multi-Slash Composer Behavior

Ling should borrow Codex's composer affordance that `/` opens the command picker at
token boundaries, including after a previously selected slash command. That behavior is
only a picker/tokenization affordance in v1:

- `/cmd args` and `@agent /cmd args` remain executable slash intents;
- `text /cmd` opens the picker and renders `/cmd` as a command chip, but sends as normal
  text because it is not an executable intent;
- `/cmd args /other` opens the picker for `/other` and renders both command tokens, but
  only the first executable intent controls the submit label and task creation;
- registered command tokens must not be parsed as workspace file references.

This keeps the Codex-style feel without introducing implicit multi-task execution.

## Inline Rendering Rules

The composer should eventually move from a raw `<textarea>` plus preview strip to a
tokenized input surface. The implementation can still keep an internal plain-text
serialization for persistence and submission, but the rendered editing surface should
display tokens inline.

Token rendering rules:

- `slash_command`: blue/control-accent chip, command icon, display label, raw command in
  compact metadata when needed; executable first command can receive a subtle underline
  or accent edge, not a separate card.
- `agent_mention`: teammate avatar or `@` icon plus display label; labels with spaces
  remain one token.
- `url_ref`: favicon or domain/provider icon plus canonical label; GitHub repository
  URLs should render like `openai/openai-agents-python`, matching Codex's compact repo
  token instead of a full link preview card.
- `file_ref`: file icon plus shortened path and optional line suffix.
- `text`: normal prose with the same baseline and line height as tokens.

Interaction rules:

- Backspace at the right edge of a token selects/removes that whole token.
- Arrow keys move through tokens predictably; the caret can sit before or after a token.
- Clicking a token selects it or opens a small contextual menu; it must not send or open
  external content by surprise.
- Copying from the composer serializes back to the original plain text, such as
  `https://github.com/openai/openai-agents-python` or `/review`.
- The submit path uses the serialized plain text plus structured refs, so no daemon
  protocol change is required for the first inline-rendering slice.

## Implementation Slice

The first implementation slice is deliberately narrow:

1. add a pure composer parser for slash intents;
2. register built-in skill ids and current workspace published Skill Library entries as slash commands in the workspace composer;
3. create task(s) for `/skill args`, `@agent /skill args`, and `@agentA @agentB /skill args`;
4. leave normal chat mention behavior untouched;
5. persist channel attachment ids on slash-created tasks;
6. show a composer command picker for `/` at token boundaries, including after
   `@agent` prefixes and after earlier slash tokens;
7. render structured slash command chips inline in the composer text flow, not as a
   separate command card or preview strip, and only use the executable first intent to
   change submit behavior.

Open follow-up decisions:

- whether private teammate-owned skills should be available through `@agent /cmd` without becoming workspace-visible;
- whether task records should store the original `ComposerSlashIntent` as first-class metadata.
