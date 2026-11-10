# IM Integrations — Feishu / WeCom / DingTalk / Slack

## Status

Status: design approved for implementation
Owner: Automations / Channels / Daemon
Last verified: 2026-10-26

## Background and competitive reference

WorkBuddy ships one-click WeChat/WeCom connection; users live in their IM.
Ling's channels are an internal team operating system — powerful, but closed:
nothing leaves or enters. The daily brief, weekly review, and governance
notifications Ling already produces have no path to where users actually are.

## Goal

1. Outbound first: automation runs and governance notifications can deliver a
   formatted message to Feishu, WeCom, DingTalk, or Slack via the platform's
   *incoming webhook* bot — zero bot-app registration, works on the free tiers
   of every platform.
2. Inbound (later phase): a reply keyword can trigger a named automation
   (requires platform app registration; designed for, not built in V1).

## Design

### 1. Destination = credential, not channel

This is deliberately *not* a new channel type. IM delivery is an **external
destination** attached to automations and governance notifications, matching
the deferred P3 "external destinations" slot.

- `packages/contracts/src/im-destinations.ts`:
  ```ts
  export type ImDestinationProvider = "feishu" | "wecom" | "dingtalk" | "slack";
  export interface ImDestination {
    id: string; label: string; provider: ImDestinationProvider;
    webhookRef: string;        // keychain/env ref, never raw URL (same policy as provider keys)
    enabled: boolean;
    secretRef?: string;        // dingtalk sign secret, feishu sign secret
  }
  ```
- Storage follows the provider-key pattern exactly (`env:`/`keychain:` refs —
  raw secrets never persist in daemon state).
- Message rendering per provider: Feishu `msg_type: interactive` card, WeCom
  `markdown`, DingTalk `actionCard`/`markdown`, Slack `blocks`. Payload
  builders are pure functions over a `DestinationMessage`
  (`{ title, bodyMarkdown, runUrl?, severity }`) — unit-testable without
  network.

### 2. Dispatch service

`packages/daemon/src/features/im-destinations/`:

- `POST /im-destinations` CRUD (refs validated, never echoed back).
- `POST /im-destinations/:id/test` sends a benign test card.
- Dispatch hook: a small `DestinationDispatcher` that item 03's notification
  service calls on run completion when the automation has
  `destinations: string[]` (additive optional field on the definition).
- Failures are captured per dispatch (status, latency, error) into the
  notification journal — visible in the automation run inspector, consistent
  with how external work records delivery.

### 3. Security posture

- Webhooks are write-only message pipes: the daemon treats them like external
  HTTP destinations already covered by the "pin audited public HTTP
  destinations" work (public HTTP egress pinning). Egress is restricted to the
  four known webhook host suffixes (`open.feishu.cn`, `qyapi.weixin.qq.com`,
  `oapi.dingtalk.com`, `hooks.slack.com`) unless the user grants an exception
  — reusing the existing audited-destination mechanism rather than inventing one.
- Signing (DingTalk `sign`, Feishu sign) computed in-daemon; secret refs only.

### 4. Inbound (phase 2, designed now)

Platform *app* mode (Feishu app subscription, WeCom callback) requires a
publicly reachable callback URL — fundamentally at odds with local-first
loopback. The design answer is the same one mobile access already uses:
paired relay. A future `im-inbound` feature would reuse the
`remote-access` pairing transport; it is recorded here so V1 choices (pure
webhook, no reply capability) are understood as deliberate.

### 5. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Automation definition schema | additive | Optional `destinations: string[]`; absent = today's behavior. |
| Notification service (item 03) | consumer | Dispatcher is a downstream subscriber; item 03 ships the hook even if this item lands later. |
| Governance notifications | consumer | Same dispatcher; channel governance digests can select a destination in existing settings UI. |
| External work | none | GitHub/Linear remain their own feature; no shared schema. |
| Provider secrets keychain | reuse | Identical ref resolution; no new secret subsystem. |

### 6. Incompatible-case upgrade path

Provider payload drift (e.g. Slack blocks deprecation) is isolated in the
per-provider builder module; a V2 wire format would add
`ImDestination.apiVersion` and dual-render behind it. Stored webhooks are refs,
so rotating a webhook needs no migration.

## Implementation plan

1. Contracts: destination types + `DestinationMessage` + payload builders (pure).
2. Daemon: CRUD routes, egress pinning integration, dispatcher + run-completion
   hook, journal entries.
3. Web: settings section "IM destinations" (list + add dialog + test button);
   automation editor multi-select for destinations.
4. Tests: builder golden tests per provider, daemon route tests (ref handling,
   egress pinning rejection), Playwright spec: create destination with mocked
   webhook, run automation, assert outbound POST payload, screenshots.

## Acceptance

- Creating a Feishu webhook destination and completing an automation run
  delivers a card (mock-server asserted payload matches provider schema).
- Invalid webhook host is rejected by egress pinning (unit test).
- All automations/external-work suites stay green.
