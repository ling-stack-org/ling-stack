# Workspace Command Rule Approval Implementation Plan

Status: approved for local implementation on `codex/codex-language-parity`

## Goal

Match the Codex Desktop Bash approval interaction: `Deny`, a primary `Allow once`, and a
small adjacent arrow that offers `Allow once` or `Allow similar commands`. The durable
choice saves one safe argv prefix for the current workspace and remains effective across
conversation surfaces and daemon restarts.

## Delivery Slices

1. Extend approval contracts, migration, storage, and API compatibility.
2. Add Bash `prefix_rule` metadata, conservative parsing, proposal validation, matching,
   mandatory-approval precedence, and atomic resolve-plus-save behavior.
3. Add the Composer split button and Workspace Settings rule list/revoke surface.
4. Add all 55 locale entries and verify Web, Core, Daemon, Runner, and API client.
5. Run `5175` against an isolated source Daemon on `17892`; exercise once, persistent,
   cross-conversation, restart, revoke, and unsafe-command paths in a real browser.

## Compatibility And Failure Rules

- Old clients approve once because omitted `decisionKind` defaults to `approve_once`.
- Old pending approvals have no proposal and therefore render no split arrow.
- A stale/mismatched proposal, concurrent decision, migration failure, or rule-save
  failure leaves no partial rule and never executes the command.
- Rule matches do not override deny, Plan Mode, Agent/Skill mandatory approval, workflow
  exact-command bindings, or high/critical risk review.
- The existing installed app and its `17891` Daemon/database are not modified for source
  acceptance.

## Acceptance

- `whois example.com` with proposal `["whois"]` can be approved once or saved as a
  workspace rule; only the saved path suppresses future matching prompts.
- The saved rule applies in channel, normal conversation, and private chat within the
  same workspace, including after Daemon restart; another workspace still prompts.
- Revoking the rule restores the prompt.
- `git`, `rm -rf`, force push, `curl | sh`, compound commands, newlines, wrappers, and
  stale fingerprints never expose or accept persistent approval.
- Screenshots show the ordinary gate, open split menu, saved-rule behavior, and revoked
  behavior with no console/page errors.

## Non-Goals

- No persistent file, network, MCP, deploy, credential, task-proposal, or global Bash
  authorization.
- No manual rule authoring, wildcard syntax, command-rule import/export, mobile target,
  push, PR, or store release.
