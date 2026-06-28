# Conversation UI Package Extraction Implementation Plan

Status: active implementation plan; first-wave package extraction implemented in the
current slice
Date: 2026-06-28
Scope: `@ling-stack/conversation-ui-core`, `@ling-stack/conversation-ui-react`,
Web adapters for normal conversation, channel chat, teammate private chat, and future
Desktop/PC renderers

Related docs:

- [Conversation Surface Contract](conversation-surface-contract.md)
- [Conversation Surface Contract Implementation Plan](conversation-surface-contract-implementation-plan.md)
- [Conversation Composer Unification Implementation Plan](conversation-composer-unification-implementation-plan.md)
- [Conversation UI Framework And Copy Canon Implementation Plan](conversation-ui-framework-copy-implementation-plan.md)
- [Conversation UI Framework Temporary Implementation Checklist](conversation-ui-framework-implementation-checklist.md)

## Goal

Extract the shared conversation UI into reusable packages without turning the package
into a hidden Web app state container.

The shared kit must cover message rendering, action bars, teammate/source stacks,
status/guidance strips, and the composer/input shell. Web surfaces keep business state:
daemon calls, route ownership, channel membership, selected teammate, model/provider
settings, permission persistence, active-run cancellation, and upload/file-picker
side effects.

## Non-Negotiable Decisions

1. `packages/conversation-ui-core` is headless and pure. It imports no React, DOM,
   browser APIs, daemon clients, app routes, or Web stores.
2. `packages/conversation-ui-react` is presentational React. It accepts view models,
   labels, callbacks, slots, and class names. It does not fetch, persist, navigate, or
   read app stores.
3. The input box is in the first-wave extraction. Composer shell, tokenized input,
   permission menu, and surface-specific composer slots move with the first package wave.
4. Channel remains the functional baseline: `/`, `@`, attachments, inline approvals,
   active guidance, stop/follow-up, and channel routing must not regress.
5. Normal conversation remains the visual baseline for the floating shell and may select
   model/thinking mode. It must not expose teammate `@` routing.
6. Teammate private chat remains one-to-one. It may show authorization and read-only
   teammate/model identity, but it must not expose teammate `@` routing or model change.
7. Shared packages may expose stable class names. CSS implementation can stay in Web in
   the first package PR; a later package CSS entrypoint is allowed only after Web proves
   the class contract.
8. `apps/web/src/shared/conversation/index.ts` can stay as a temporary compatibility
   re-export layer during migration.

## Target Package Boundaries

```text
packages/conversation-ui-core
  -> pure surface policy, composer policy, input token parsing, action filtering,
     message-body parsing, and shared view-model types

packages/conversation-ui-react
  -> React conversation shell/feed/message/composer primitives that render only from
     props, labels, callbacks, slots, and class names

apps/web
  -> adapters, daemon/API calls, routing, uploads, file picking, model/provider state,
     permission persistence, active-run behavior, i18n label mapping, and CSS tokens
```

## Core Package Design

Immediate first-wave files:

```text
packages/conversation-ui-core/src/
  index.ts
  surface-policy.ts
  composer-input-parts.ts
  slash-command-picker.ts
  message-body.ts
  permission-policy.ts
  conversation-types.ts
  work-cell-view-model.ts
```

Later core candidates:

```text
packages/conversation-ui-core/src/
  transcript-types.ts
  renderer-registry.ts
  action-policy.ts
  evidence-view-model.ts
```

Allowed:

- discriminated union types,
- pure parsing and filtering helpers,
- pure policy derivation from explicit input state,
- stable view-model types that can be constructed by Web and Desktop,
- package-local tests that run without React.

Forbidden:

- `react` imports,
- browser-only APIs such as `window`, `document`, `navigator`, `File`, or
  `localStorage`,
- daemon/API clients,
- Web app stores or routes,
- app i18n hooks,
- CSS imports.

## React Package Design

First-wave package layout:

```text
packages/conversation-ui-react/src/
  index.ts
  blocks/
    ConversationShell.tsx
    ConversationFeed.tsx
    ConversationEmptyState.tsx
    MessageRow.tsx
    MessageBubble.tsx
    MessageBodyRenderer.tsx
  composer/
    ConversationComposerShell.tsx
    TokenizedComposerInput.tsx
    ComposerPermissionMenu.tsx
  feedback/
    CopyActionButton.tsx
    MessageActionBar.tsx
    ConversationStatusStrip.tsx
    ConversationGuidanceStrip.tsx
  identity/
    SourceIconStack.tsx
    TeammateAvatarStack.tsx
```

Package metadata:

```json
{
  "name": "@ling-stack/conversation-ui-react",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "dependencies": {
    "@ling-stack/conversation-ui-core": "workspace:*",
    "lucide-react": "^0.468.0"
  }
}
```

The exact React versions should be rechecked against `apps/web/package.json` during
implementation if dependencies change.

## First-Wave Migration Map

| Current file | Target | Required adaptation |
| --- | --- | --- |
| `blocks/ConversationShell.tsx` | `conversation-ui-react/blocks` | Move directly if props remain React-only and app-agnostic. |
| `blocks/ConversationFeed.tsx` | `conversation-ui-react/blocks` | Move with `ConversationEmptyState`; no app dependency allowed. |
| `blocks/ConversationEmptyState.tsx` | `conversation-ui-react/blocks` | Move directly; icon dependency is allowed through `lucide-react`. |
| `blocks/MessageRow.tsx` | `conversation-ui-react/blocks` | Import package `MessageBodyRenderer`; no app state. |
| `blocks/MessageBubble.tsx` | `conversation-ui-react/blocks` | Import package `MessageBodyRenderer`; no app state. |
| `blocks/MessageBodyRenderer.tsx` | `conversation-ui-react/blocks` | Move with renderer slots for code, diff, and local-file tokens so Web can keep rich renderers local until second wave. |
| `feedback/CopyActionButton.tsx` | `conversation-ui-react/feedback` | Remove `useI18n`; require `copiedLabel` or default to a package literal. |
| `feedback/MessageActionBar.tsx` | `conversation-ui-react/feedback` | Import policy from `conversation-ui-core`; remove Web i18n; accept `copiedLabel` and optional copy renderer. |
| `composer/ConversationComposerShell.tsx` | `conversation-ui-react/composer` | Move directly; keep slot-only API. |
| `composer/TokenizedComposerInput.tsx` | `conversation-ui-react/composer` | Move after `ComposerInputPart` is in core. |
| `composer/ComposerPermissionMenu.tsx` | `conversation-ui-react/composer` | Remove Web `PermissionPreset` and `session-permissions`; accept package permission options, labels, descriptions, and confirmation callback. |
| `feedback/ConversationStatusStrip.tsx` | `conversation-ui-react/feedback` | Move directly if labels are passed by props. |
| `feedback/ConversationGuidanceStrip.tsx` | `conversation-ui-react/feedback` | Remove `useI18n`; require fallback labels through props or package defaults. |
| `identity/SourceIconStack.tsx` | `conversation-ui-react/identity` | Move after `SourceIconKind` comes from core. |
| `identity/TeammateAvatarStack.tsx` | `conversation-ui-react/identity` | Move directly; avatar URL/name props only. |
| `composer/composer-input-parts.ts` | `conversation-ui-core` | Move as pure parser; ensure it imports only core `message-body` helpers. |
| `composer/slash-command-picker.ts` | `conversation-ui-core` | Move as pure picker helper. |
| `tokens/message-body.ts` | `conversation-ui-core` | Move as pure message/body parser before `MessageBodyRenderer`. |

## First-Wave Renderer Slot Contract

`MessageBodyRenderer` must not force `CodeBlock`, `DiffCodeBlock`, or `LocalFileLink`
into the React package before those dependencies are audited. The first package API
should use optional render slots:

```ts
export interface MessageBodyRendererProps {
  readonly text: string;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly allowMarkdown?: boolean;
  readonly streaming?: boolean;
  readonly className?: string;
  readonly renderCodeBlock?: (input: MessageCodeBlockRenderInput) => ReactNode;
  readonly renderDiffBlock?: (input: MessageDiffBlockRenderInput) => ReactNode;
  readonly renderLocalFile?: (input: MessageLocalFileRenderInput) => ReactNode;
  readonly onOpenLocalFile?: (reference: LocalFileReference) => void;
}
```

Package defaults may render plain `<pre>` code and non-clickable local-file labels. Web
adapters pass existing `CodeBlock`, `DiffCodeBlock`, and `LocalFileLink` until those
components pass the second-wave dependency audit.

## Composer Public Contract

The first-wave composer package should expose shell/input/menu primitives, not a full
business state machine:

```ts
export type ConversationComposerSurface = "channel" | "normal_conversation" | "teammate_direct";
export type ConversationComposerDensity = "floating" | "docked";

export interface ConversationComposerShellProps {
  readonly surface: ConversationComposerSurface;
  readonly density?: ConversationComposerDensity;
  readonly disabled?: boolean;
  readonly active?: boolean;
  readonly statusNode?: ReactNode;
  readonly approvalNode?: ReactNode;
  readonly guidanceNode?: ReactNode;
  readonly previewNode?: ReactNode;
  readonly inputNode: ReactNode;
  readonly leftToolsNode?: ReactNode;
  readonly rightToolsNode?: ReactNode;
  readonly feedbackNode?: ReactNode;
  readonly className?: string;
}
```

Surface adapters decide which nodes are present:

| Surface | Required slots | Forbidden slots |
| --- | --- | --- |
| Channel | attach, slash, teammate mention, authorization, approval, guidance, send/stop/follow-up | model picker |
| Normal conversation | attach, slash, model/thinking, authorization, send | teammate mention |
| Teammate private | attach, slash, authorization, optional read-only model status, direct guidance send/stop | teammate mention, model picker |

## Permission Menu Contract

`ComposerPermissionMenu` cannot depend on Web session helpers. It should receive a
prop-driven option list:

```ts
export type ConversationPermissionPreset =
  | "read_only"
  | "workspace_collaboration"
  | "full_access"
  | "custom";

export interface ConversationPermissionPresetOption {
  readonly preset: ConversationPermissionPreset;
  readonly label: string;
  readonly description: string;
  readonly requiresConfirmation?: boolean;
}

export interface ComposerPermissionMenuProps {
  readonly preset: ConversationPermissionPreset;
  readonly options: readonly ConversationPermissionPresetOption[];
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly confirmChange?: (preset: ConversationPermissionPreset) => boolean | Promise<boolean>;
  readonly onPresetChange: (preset: ConversationPermissionPreset) => void;
}
```

Web maps its existing permission presets and localized labels into this contract. Active
execution lock remains explicit: the adapter passes `disabled=true` while a run/model call
or direct reply is active.

## Web Adapter Responsibilities

Keep these in `apps/web`:

- `WorkspaceClientView` channel send/routing/active-run state,
- normal conversation model/thinking state and conversation stream payload,
- teammate direct reply state and selected teammate/provider identity,
- attachment upload endpoints and `File` handling,
- permission preset persistence and full-access confirmation copy,
- i18n translation hooks,
- CSS token definitions and surface placement wrappers,
- Playwright fixtures and app-level smoke coverage.

`apps/web/src/shared/conversation/index.ts` should temporarily re-export first-wave
package components:

```ts
export * from "@ling-stack/conversation-ui-react";
export * from "@ling-stack/conversation-ui-core";

// Keep Web-only second-wave exports local until audited.
export { ConversationWorkCell } from "./blocks/ConversationWorkCell.js";
export { ConversationAttachmentStrip } from "./preview/ConversationAttachmentStrip.js";
```

## Second-Wave Audit

These components stay Web-local until their imports are clean:

| Component | Reason to defer |
| --- | --- |
| `ConversationWorkCell` | Renderer and builders still depend on Web run/work evidence, preview loading, i18n, and view-store behavior. App-agnostic view-model types live in `conversation-ui-core`. |
| `ConversationAttachmentStrip` | Needs attachment/file scope and preview behavior audit. |
| `EvidenceDisclosure` / evidence panels | Evidence visibility policy still differs by surface and data availability. |
| `FileRefChip` | Workspace/file opening behavior is app-owned. |
| `CodeBlock` / `DiffCodeBlock` / `DiffViewer` | Current highlighting, diff parsing, copy feedback, and deferral utilities need dependency cleanup. |
| `ArtifactPreviewDrawer` / `ImageCompareViewer` | App preview/lightbox ownership and image compare data are not first-wave package concerns. |
| `RightDrawer` | App shell utility, not conversation UI kit. |
| `view-store/*` | Keep local until Desktop needs the same reconciliation store. |

## Implementation Slices

### Slice A: Core Parser And Policy Expansion

Work:

- move pure `message-body`, `composer-input-parts`, and `slash-command-picker` helpers
  into `conversation-ui-core`,
- add permission preset types/options if needed,
- update package exports and pure tests,
- keep Web compatibility imports working through re-exports.

Validation:

```bash
corepack pnpm --filter @ling-stack/conversation-ui-core test
corepack pnpm --filter @ling-stack/web typecheck
git diff --check
```

### Slice B: React Package Shell

Work:

- create `packages/conversation-ui-react`,
- move dependency-clean first-wave components,
- convert Web i18n and permission dependencies to labels/options/slots,
- keep CSS in Web but preserve stable class names,
- add Web dependency on `@ling-stack/conversation-ui-react`.

Validation:

```bash
corepack pnpm --filter @ling-stack/conversation-ui-react typecheck
corepack pnpm --filter @ling-stack/web typecheck
rg -n "apps/web/src|@ling-stack/api-client|@ling-stack/core|localStorage" packages/conversation-ui-react/src packages/conversation-ui-core/src
git diff --check
```

### Slice C: Web Rewire And Regression Lock

Work:

- keep `apps/web/src/shared/conversation/index.ts` as the compatibility boundary,
- update direct imports only when needed,
- verify normal conversation, channel, and teammate private chat still share visuals and
  capability differences,
- add focused e2e assertions for composer package usage and private/channel capability
  gates.

Validation:

```bash
corepack pnpm --dir apps/web exec playwright test e2e/app.spec.ts -g "normal conversation composer sends and replays uploaded attachments|conversation home uses plus as the single attachment entry|conversation home sends with workspace cwd" --workers=1
corepack pnpm --dir apps/web exec playwright test e2e/teammates.spec.ts -g "channel and private chat empty message states share conversation visuals|AI teammate private chat exposes direct reply guidance and stop controls" --workers=1
```

### Slice D: Second-Wave Components

Work:

- audit `ConversationWorkCell`, evidence panels, attachment strip, file chips, code/diff
  renderers, and view-store imports,
- move only components that can render from package-local view models and app-provided
  callbacks,
- add fixture stories/tests before Desktop consumes them.

Do not start Slice D in the first package PR.

## Dependency Guard

Before merging any package extraction PR, these searches must return no matches in package
source:

```bash
rg -n "apps/web/src" packages/conversation-ui-core/src packages/conversation-ui-react/src
rg -n "@ling-stack/api-client|@ling-stack/core" packages/conversation-ui-core/src packages/conversation-ui-react/src
rg -n "useI18n|localStorage|window\\.location|document\\.|navigator\\." packages/conversation-ui-core/src packages/conversation-ui-react/src
```

Allowed exceptions:

- `navigator.clipboard` may appear only inside a React `CopyActionButton` helper if it is
  feature-detected and has no app dependency.
- DOM event types may appear in `conversation-ui-react`, not in `conversation-ui-core`.

## Done Criteria

First package extraction is complete when:

- `@ling-stack/conversation-ui-react` exists and typechecks,
- Web imports first-wave components through the package or a compatibility re-export,
- normal conversation, channel, and private chat visuals remain aligned,
- channel still supports `@`, slash commands, files, approvals, guidance, stop, and
  follow-up,
- normal conversation still supports model/thinking selection and does not show `@`,
- private chat still blocks `@` and model changes,
- packages do not import app/daemon/API modules,
- focused Web typecheck and e2e checks pass,
- second-wave components are explicitly left Web-local with documented reasons.

## Implementation Status - 2026-06-28

Implemented in the first-wave package extraction slice:

- created `packages/conversation-ui-react` with package metadata, TypeScript build,
  public exports, React peer dependencies, and `lucide-react` dependency,
- expanded `packages/conversation-ui-core` with pure composer input parsing, slash
  command picker helpers, message-body parsing, shared message/action item types,
  work cell view-model types, and permission preset metadata,
- added core tests for composer token parsing, slash picker insertion, token removal,
  work cell view-model alias normalization, and permission confirmation derivation,
- moved first-wave React primitives into `@ling-stack/conversation-ui-react`:
  `ConversationShell`, `ConversationFeed`, `ConversationEmptyState`, `MessageRow`,
  `MessageBubble`, `MessageBodyRenderer`, `MessageActionBar`,
  `ConversationComposerShell`, `TokenizedComposerInput`, `ComposerPermissionMenu`,
  `ConversationStatusStrip`, `ConversationGuidanceStrip`, `TeammateAvatarStack`, and
  `SourceIconStack`,
- removed Web-only dependencies from the React package: no Web i18n hook, no
  `session-permissions` import, no app route/API imports, and no app store imports,
- switched Web shared conversation/component compatibility entrypoints to re-export
  first-wave package components and core pure helpers,
- switched Web conversation item/action token types and work cell view-model types to
  source from `@ling-stack/conversation-ui-core` while keeping Web builders/renderers
  local,
- updated Web package scripts so build/typecheck/e2e build `conversation-ui-react`
  before the Web app.

Still intentionally Web-local after this slice:

- `ConversationWorkCell`,
- `EvidenceDisclosure` and evidence panels,
- `ConversationAttachmentStrip`,
- `FileRefChip`,
- `CodeBlock`, `DiffCodeBlock`, `DiffViewer`, and diff summary rendering,
- `ArtifactPreviewDrawer`, `ImageCompareViewer`, `RightDrawer`, app shell, settings,
  teammate management, channel configuration, and API/route-bound components.

## Open Decisions

No product decision blocks Slice A through Slice C.

Deferred decisions:

- whether package CSS moves into `@ling-stack/conversation-ui-react/styles.css` after Web
  proves the class/token contract,
- whether Desktop consumes `conversation-ui-react` directly or wraps it in a native shell,
- whether `ConversationWorkCell` should move as one renderer or split into smaller
  operation/evidence primitives.
