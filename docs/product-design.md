# Product Design

## One-Line Positioning

Ling Stack is a multilingual, local-first AI teammate workspace with an initial provider focus on domestic AI vendors, plus first-class GPT, Claude, and OpenAI-compatible relay entry points.

## Core Bet

The product should not compete as a chat client. It should compete as a work surface:

> Channels hold context. Tasks define executable work. AI teammates run scoped sessions. Humans approve risky actions. Everything leaves an audit trail.

## Target Users

- Developers who use multiple providers and want one local workspace.
- Small teams that need AI to help with code, docs, support, operations, and media tasks.
- Multilingual teams and developers that need Doubao, DeepSeek, MiniMax, GLM, Jimeng, GPT, Claude, and local relay support.
- Agent power users who already use Codex, Claude Code, MCP, local proxies, or provider relays.

## Key Objects

### Workspace

A local or team-scoped container for channels, tasks, teammates, providers, and policy.

### Channel

A context container for a project or workflow. A channel can bind:

- Local directory.
- Git repository.
- Knowledge files.
- Provider defaults.
- Tool permissions.
- AI teammate membership.

### Task

The smallest unit of executable AI work.

Suggested states:

- `todo`
- `claimed`
- `running`
- `blocked`
- `review`
- `done`
- `failed`
- `cancelled`

### AI Teammate

A configured role with model, tools, memory, budget, and approval policy.

Examples:

- Engineer.
- Researcher.
- Docs maintainer.
- Ops assistant.
- Media generator.
- Support drafter.

### Runtime Session

A session records what actually happened:

- Input prompt and task context.
- Model calls.
- Tool calls.
- Shell commands.
- File diffs.
- Artifacts.
- Errors.
- Final report.

### Approval

An explicit human decision point.

Approval should be required for:

- File writes outside an allowed path.
- Git commits and pushes.
- External messages or emails.
- Paid or high-cost media generation.
- Deployment, production changes, credential changes, or destructive actions.

## MVP

v0.1 should prove local usefulness:

1. Configure providers.
2. Create a channel bound to a local project.
3. Create a task.
4. Run an AI teammate against the task.
5. Capture session logs and artifacts.
6. Review and approve risky actions.
7. See everything in a local timeline UI.

## Non-Goals For v0.1

- Full Slack/Feishu/DingTalk/WeCom integration.
- Multi-user cloud sync.
- App Store distribution.
- Email and meeting automation.
- Autonomous production changes.

## Product Red Lines

- Do not hide what the AI did.
- Do not make every provider look identical when capabilities differ.
- Do not auto-execute destructive or external actions.
- Do not make the desktop app the product bottleneck.
- Do not store API keys unencrypted once desktop/keychain support exists.
