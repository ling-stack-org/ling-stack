# Ling 项目缺陷修复合同

Status: implemented remediation contract; platform acceptance pending
Owner: Web、Desktop、Chrome integration、daemon and release maintainers
Last verified: 2026-09-03
Document type: cross-module behavior contract
Canonical plan: [Project Defect Remediation Plan 2026-09](project-defect-remediation-plan-2026-09.md)
Code and test anchors: listed per module below

## Purpose

This contract records the five defects found in the 2026-09 project review. It defines
ownership and observable behavior so that a visual cleanup cannot silently remove a
working capability, and a transport recovery fix cannot leave durable state half migrated.

## Module Ownership

| Defect | Owning module | Primary anchors | Required outcome |
|---|---|---|---|
| Review mode controls do nothing | Workspace right-dock review detail | `apps/web/src/features/workspace/right-dock/DockReviewItemDetail.tsx`, `apps/web/src/styles/channel-right-dock/review-details.css` | Every visible mode is either a working control with state and keyboard behavior, or is rendered as non-interactive metadata. No inert button-shaped control remains. |
| Run lookup is discarded | Runs / Run Inspector | `apps/web/src/features/runs/RunInspector.tsx`, `apps/web/src/features/inspector/PageInspector.tsx`, `apps/web/src/app/AppShell.tsx` | Run ID lookup, load, selected run, events and artifacts have one explicit owner and a testable success, empty, loading and failure state. |
| Profile copy bypasses i18n | Settings / Profile | `apps/web/src/features/profile/ProfilePage.tsx`, `apps/web/src/i18n/locales/` | All user-visible and accessibility copy is translated through the shared i18n path. Locale fallback must not leave Chinese-only controls in non-Chinese locales. |
| Native Broker startup can remain half-open | Daemon / Chrome Native Broker | `packages/daemon/src/features/browser-extension/native-broker.ts`, `packages/daemon/src/index.ts` | Startup is all-or-clean: a failed descriptor publication closes the listener, removes only owned state, and permits a later retry. No listening broker without a valid descriptor is reported as available. |
| Native migration can revoke before confirmation | Daemon / Chrome session migration | `packages/daemon/src/features/browser-extension/session-controller.ts`, `packages/daemon/src/features/browser-extension/native-broker.ts` | A failed Native handshake does not strand legacy credentials. Legacy revocation occurs only at the defined migration commit point, and concurrent replacement remains single-winner. |

## Behavioral Rules

### UI capability truth

- A control must have a state owner, an event handler, a visible state transition, and an
  accessible name.
- If a review mode is not backed by a real projection or API, it must not look selectable.
- Run lookup must not retain unused props or callbacks as a substitute for a user path.
- Removing duplicate copy or decorative status must not remove the underlying model, query,
  or action.

### Internationalization

- Profile headings, labels, buttons, status text, empty states, tooltips, titles, and ARIA
  labels use the shared translation function.
- New translation keys are added to the locale source according to the repository's locale
  contract; no locale receives a raw Chinese fallback for a product control.
- Technical values such as model names, handles, dates, and paths remain data, not translation
  keys.

### Native startup recovery

1. Bind the loopback listener.
2. Create and publish the protected runtime descriptor.
3. Only then expose the broker as started.
4. If any step after binding fails, close the listener and remove a descriptor only when its
   generation belongs to this broker.
5. A later start attempt must be able to bind and publish again.

Descriptor refresh failure must not silently make the broker unusable. The implementation
must either retry with bounded diagnostics or transition to an explicitly unavailable state
that can be repaired without restarting the whole daemon.

### Native migration commit

- Validate origin, token, extension/host versions, plugin enablement, and workspace authority
  before changing legacy credentials.
- Install the Native transport and send the ready response as one logical acceptance boundary.
- If ready cannot be delivered or the transport closes before confirmation, preserve the legacy
  credential and expose a retryable failure.
- After the commit point, revoke the old credential and remove the extension's legacy storage.
- Repeated or concurrent migration attempts may produce only one active session and may not
  revive a revoked credential.

## Non-Goals

- No new browser capability, MCP tool, permission model, database schema, or remote transport.
- No redesign of the right dock, runs information architecture, or Profile visual language.
- No change to Chrome Web Store identity, Native Messaging protocol names, workspace authority,
  or existing approval semantics.
- No claim of Windows or macOS release acceptance without the corresponding real host test.

## Acceptance Evidence

- Web unit/typecheck/lint/i18n checks pass, including non-Chinese Profile rendering.
- Right-dock controls and Run Inspector are exercised in a real browser with console/page-error
  capture.
- Native Broker has deterministic tests for publish failure, cleanup, retry, migration failure,
  migration success, duplicate attempts, and legacy compatibility.
- Desktop and Native Host tests pass on the platforms they claim to cover.
