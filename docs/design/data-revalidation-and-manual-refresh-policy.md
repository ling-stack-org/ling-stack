# Data Revalidation And Manual Refresh Policy

Status: active product and frontend contract
Owner: Web AppShell, feature domains, and UI surface owners
Last verified: 2026-08-03
Document type: product contract
Code anchors: `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/use-control-plane-invalidation.ts`,
`apps/web/src/shared/hooks/use-focus-revalidation-token.ts`
Test anchors: `apps/web/e2e/app.spec.ts`, `apps/web/e2e/ui2-normal-conversation.spec.ts`,
`apps/web/e2e/ui2-model-workbench.spec.ts`, `apps/web/e2e/ui2-settings-mcp-tools.spec.ts`

## Product Decision

Ling keeps data current automatically. A normal page, list, header, popover, drawer, or
dialog must not expose a generic Refresh action merely as a fallback for state ownership.
The user should act on product objects, while the client owns revalidation.

Automatic revalidation occurs when:

- the user enters a product surface or selects another product object;
- the daemon control plane reports a changed domain;
- an active run, media job, or automation requires bounded polling;
- the app regains focus, becomes visible, or returns online after a short stale interval;
- a successful mutation requires the owning object or list to be reconciled.

Revalidation retains the last successful data, scopes busy state to the owning surface,
and prevents an older response from overwriting a newer mutation.

## User-Facing Actions

Generic Refresh is allowed only as an error recovery action. It must be rendered beside
the failed or stale object and named `Retry`.

Actions that inspect or mutate state outside Ling use their real verb:

| Job | Product label |
| --- | --- |
| Reconnect to the local daemon | Reconnect |
| Re-read Git or workspace files | Rescan changes |
| Probe runtime, workspace, provider, or permission state | Check status |
| Fetch an MCP server catalog | Sync tools |
| Poll an external work provider | Poll once |
| Reconcile external and local records | Reconcile |
| Replace a stale editor version | Load latest version |
| Re-import or repair a package | Re-import / Repair |

Do not use a circular-arrow icon to disguise rerun, regenerate, rollback, repair, retry,
or destructive confirmation as generic Refresh.

## Surface Rules

- Conversation, channel, private chat, page headers, list toolbars, right docks, and
  management dialogs do not show Refresh in their normal state.
- Model, teammate, skill, MCP, plugin, approval, run, media, automation, and council
  mutations update their local owner and then reconcile automatically.
- Load failures retain previous data and expose Retry inline. Empty initial failures use
  one compact error state with Retry.
- Diagnostics and external-state inspectors may keep a manual action, but it must say
  what is checked or rescanned.
- Pending or hidden product surfaces follow the same rule before being made visible.
- Keyboard and screen-reader users receive the same action names; icon-only controls use
  the explicit product label as their accessible name.

## Focus Revalidation

The Web client uses one shared focus revalidation token. `focus`, visible
`visibilitychange`, and `online` events may advance the token at most once per stale
window. Feature effects consume the token using their existing request guards.

Focus revalidation must not:

- clear drafts, editor input, search, filters, selection, scroll, or open overlays;
- show a global loading screen when retained data exists;
- start paid generation, rerun work, synchronize tools, or perform any mutation;
- bypass daemon authority, approval, or capability checks.

## Compatibility Boundary

This policy changes Web presentation and revalidation triggers only. It does not change
daemon APIs, SQLite, control-plane events, task execution, media generation, approval
semantics, external-work polling, or Desktop native recovery.

## Implementation Evidence

Implemented on 2026-08-03 through the shared
`useFocusRevalidationToken()` lifecycle hook and feature-owned revalidation effects.
Normal-state Refresh controls were removed from conversations, channels, management
workbenches, nested inspectors, and dialogs. Runtime, CI, workspace-change, and other
external-state actions now use explicit Check or Rescan labels, while load failures keep
inline Retry.

Verification covered Web typecheck, UI2 guards, i18n, Web unit tests, source scans, and
focused Playwright suites for conversations, channels, models, teammates, councils,
runs, approvals, media, plugins, automations, MCP, Settings, and Work Board. The focused
browser runs exercised Light 1440x960, Dark 1280x800, keyboard focus, retained stale
data, late responses, and local Retry recovery.

## Acceptance

- Released surfaces contain no normal-state button whose accessible name is exactly
  `Refresh` or `刷新`.
- Error states continue to offer Retry without losing retained data.
- External-state actions use explicit labels and still execute the same existing API.
- Returning to a visible app revalidates only the active surface after the stale window.
- Light/Dark, keyboard focus, narrow desktop, i18n, and late-response ownership remain
  covered by focused E2E tests.
