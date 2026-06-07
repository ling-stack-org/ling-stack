# Product Design

## One-Line Positioning

Ling Stack is a multilingual, local-first AI teammate workspace with a Model Workbench for domestic AI vendors, GPT, Claude, OpenAI-compatible relays, and custom compatible endpoints.

## Core Bet

The product should not compete as a chat client. It should compete as a work surface:

> Channels hold context. Tasks define executable work. AI teammates run scoped sessions. Humans approve risky actions. Everything leaves an audit trail.

## Current Mainline

The mainline now follows the AI teammate workspace shape: channels, tasks, coding sessions, provider readiness, approvals, and artifacts in one local loop. The next product emphasis is not another media adapter. It is making multi-model and domestic/custom model setup first-class enough that a user can configure a provider, check it, select it for a task, run the task, and repair failures without leaving the Web/CLI workflow.

Model Workbench owns that loop:

- group GPT/Claude, domestic AI, OpenAI-compatible relay, custom compatible access, and media providers clearly,
- accept custom OpenAI-compatible endpoints with `displayName`, `baseUrl`, `model`, `apiKeyRef`, capabilities, reasoning, context, and max token fields,
- keep secrets as `env:NAME` or fail-closed `keychain:NAME` refs, never raw keys,
- show whether a provider is usable for coding tasks: enabled, key-ready, check-ready, chat-capable, and not media-only,
- keep media providers visible but outside the normal coding task provider picker.

Seedream `image_generate` remains a recorded media baseline with approval and artifact paths. Jimeng, Seedance, billing, desktop packaging, and keychain storage are deliberately downstream of the Model Workbench mainline.

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

Local runtime permission approvals should appear near the active run or channel context
first. Cross-context review and external action approvals belong in the Review Queue and
Work Board model defined in
[Work Board, Review Queue, and Inline Approval Boundaries](design/work-board-review-queue.md).

### Review Queue And Work Board

Review Queue is the routing surface for external work, high-risk external actions,
offline pending approvals, and cross-channel handoffs. It is not the primary surface for
normal local runtime permission prompts.

Global Work Board is the all-work ledger across channels. Channel Work Board is the
channel-filtered execution view backed by the same underlying work records.

## MVP

v0.1 should prove local usefulness:

1. Configure providers.
2. Create a channel bound to a local project.
3. Create a task.
4. Run an AI teammate against the task.
5. Capture session logs and artifacts.
6. Review and approve risky actions.
7. See everything in a local timeline UI.

The provider configuration step should be demoable through Model Workbench, not only through daemon API examples. A custom domestic or OpenAI-compatible endpoint should be able to move from setup hint to provider check to task run and back to repair/rerun if the provider fails.

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
