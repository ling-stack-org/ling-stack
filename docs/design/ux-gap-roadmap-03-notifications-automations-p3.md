# Desktop Notifications + Automations P3 Closure

## Status

Status: design approved for implementation
Owner: Automations / Desktop / Web
Last verified: 2026-10-26

## Background and competitive reference

ZCode and Codex Desktop keep users informed with OS notifications when
scheduled/background work finishes. Ling's automations implemented P0/P1
(definitions, templates, scheduler, manual runs) and partial P2 (monitors);
P3 was explicitly deferred — desktop scheduler opt-in, notification
preferences, exportable report artifacts, external destinations. Today a
scheduled run finishing is silent: the user must poll the Runs page.

## Goal

1. A finished (or failed, or approval-blocked) automation run can raise an OS
   notification on desktop, and an in-app toast on web.
2. Users control granularity per automation and globally.
3. A completed run can produce an exportable markdown report artifact.
4. External destinations (IM webhooks) are covered by item 04
   ([ux-gap-roadmap-04-im-integrations.md](ux-gap-roadmap-04-im-integrations.md));
   this item only reserves the dispatch hook.

## Design

### 1. Notification pipeline: daemon decides, client delivers

The daemon owns run state transitions, so it owns *what* to notify. Clients
own *how* (OS toast vs web Notification API).

- `packages/contracts`: `NotificationEvent` =
  `{ kind: "automation_run_finished" | "automation_run_failed" | "approval_required" | "governance", automationId?, runId?, title, body, createdAt }`.
- Daemon: new `features/notifications/` service. Subscribes internally to run
  completion events (same projection the Runs feature already emits). Persists
  a bounded, redacted notification journal (survives restart, feeds a "recent
  notifications" list).
- Delivery: daemon exposes a long-poll/SSE endpoint `GET /notifications/stream`
  (the daemon already serves loopback HTTP; conversations use similar
  streaming). Desktop Electron main process consumes the stream and calls the
  `Notification` API; web consumes it and calls `new Notification(...)`.
- This deliberately avoids a new push channel: one loopback stream, thin
  clients, consistent with the existing architecture.

### 2. Preferences

- `packages/contracts/src/notifications.ts`:
  `NotificationPreferences = { globalEnabled, events: { [kind]: "all" | "failures" | "off" }, quietHours?: { start, end } }`.
- Daemon stores per-profile preferences (existing settings storage); automations
  can override globally-per-automation via a single field
  `notifications: "inherit" | "all" | "failures" | "off"` on the definition
  schema (additive, optional → fully backward compatible with stored
  definitions).
- Settings UI lives in the new Startup & diagnostics / maintenance surface —
  see [ux-gap-roadmap-13-startup-diagnostics.md](ux-gap-roadmap-13-startup-diagnostics.md) —
  under a "Notifications" card; per-automation toggle lives on the existing
  automation editor form.

### 3. Exportable reports (P3 item)

Automation run completion gains an optional `exportReport: boolean`
(definition field, default false). When set, the daemon renders the run's
existing summary + evidence into a markdown artifact and registers it via the
artifact registry — same mechanism media jobs use. No new artifact type.

### 4. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Automation definition schema | additive | Optional `notifications` + `exportReport` fields; absent = old behavior. Stored JSON ignores unknown fields (schema validation is strict for required fields only — verified against `schemas.ts`). |
| Scheduler | unchanged | Notifications subscribe to run completion; scheduler does not call notification code directly. |
| Governance notifications feature | coexists | Governance notifications are channel-scoped and remain untouched; the new service is run-scoped. A later unification can route governance events into the same stream by adding a `NotificationEvent.kind`. |
| Electron main | small | New `apps/desktop/main/notifications/` module subscribing to the daemon stream; guarded by capability check so unsigned-alpha runs without OS notification permission degrade to in-app toasts. |
| Browser web app | small | `Notification` API behind permission request triggered from the preferences card (never on page load). |

### 5. Incompatible-case upgrade path

If the stream contract changes (new fields), the journal and clients key on
`kind` + `runId` and ignore unknown fields; stream version is announced via a
`ling-notification-version` header so a future desktop can feature-detect.

## Implementation plan

1. Contracts: event + preferences types; api-client methods (stream + prefs CRUD).
2. Daemon: notifications service (journal, prefs storage, SSE/long-poll route),
   hooks on run completion, report export field.
3. Web: preferences card, per-automation field, in-app toast + Notification bridge.
4. Desktop: main-process notifier module with permission degradation.
5. Tests: daemon service unit tests (transition → event → journal), route test
   (stream emits on synthetic completion), Playwright spec with mocked daemon:
   run finishes → toast visible + notification permission prompt suppressed,
   screenshot evidence.

## Acceptance

- Completing a mocked automation run shows a toast in web and fires an OS
  notification in desktop dev build; quiet hours suppress it (unit-tested).
- `exportReport: true` run registers a markdown artifact visible in Runs.
- Existing automations suites stay green.
