# Product UX Priorities P6

## Related Docs

- [Product UX System P5](product-ux-system-p5.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [P5 Next Implementation Plan](product-ux-system-p5-next-implementation-plan.md)
- [P5 Status Semantics Follow-up](product-status-semantics-p5-followup.md)
- [P6 Implementation Plan](product-ux-priorities-p6-implementation-plan.md)
- [P7 Usage Closure](product-ux-usage-closure-p7.md)
- [P7 Usage Closure Detailed Design](product-ux-usage-closure-p7-detailed-design.md)
- [P7 Usage Closure Implementation Plan](product-ux-usage-closure-p7-implementation-plan.md)

## Summary

P5 reduced structural UX debt: shared presentation primitives exist, major surfaces have
adopted them, status semantics are clearer, Settings is less repetitive, and `i18n.tsx`
no longer carries the full dictionary payload. The next product UX pass should stop
treating component adoption as the main job and move to real desktop first-screen
comfort.

P6 focuses on four user-visible priorities:

1. Settings deep-page visual density.
2. Work Board product mental model.
3. Model Workbench beginner setup path.
4. Conversation, channel, and private-chat interaction details.

This is not a new information architecture, not a backend change, and not a broad visual
redesign. It is a product interaction pass that makes Ling feel calmer, easier to scan,
and more obvious about the next action.

## Product Direction

Ling should feel like a local-first AI workspace, not a diagnostics console. P6 keeps the
existing quiet operational style, but tightens what appears by default:

- Default screens show the task, current state, and next action.
- Explanations appear only when they unblock a decision.
- Diagnostics remain available, but not as the first thing a normal user reads.
- Technical pages may expose technical facts, but their first screen still needs a
  product path.
- Empty, blocked, and failed states should always say where to go next.

## Priority 1: Settings Deep-Page Visual Density

### Problem

Settings now has the right IA, and the top-level duplicate headers have been reduced.
The remaining risk is in deep pages where a user can still see page titles, tabs,
subsection headings, gray descriptions, status grids, diagnostics, and action copy all at
once.

This can make Settings feel heavier than the rest of the product, especially on pages
such as Skill Library, Skills, Execution Permissions, External Work, and Maintenance.

### Detailed Design

- Keep Settings left navigation and route behavior unchanged.
- Treat each Settings page first screen as a working panel, not a documentation page.
- First screen may show:
  - one task title;
  - one compact state summary or status row;
  - the primary action or the next required setup action;
  - persistent errors or blockers.
- Move repeated explanations into:
  - existing `details` disclosures;
  - row-level help only where the control is hard to understand;
  - diagnostic/detail panels below the fold;
  - empty or blocked states that need the explanation.
- Do not remove necessary evidence from diagnostic pages. Instead, make evidence
  progressive: summary first, details second.
- Keep descriptions hidden by default in `SettingsSubnav`; only opt in when a panel has
  no other local explanation and the text directly affects the current decision.

### Acceptance Criteria

- Settings deep pages do not show a second layer of gray explanatory text under every
  tab or section.
- A new user can identify the primary action on each deep page without reading
  diagnostics first.
- Startup readiness, Skill Library, and external work details still expose enough
  evidence for troubleshooting.
- No Settings page introduces horizontal overflow at desktop widths.

## Priority 2: Work Board Product Mental Model

### Problem

Work Board is useful but can easily feel like an internal operations table. Its product
job is not "show every work item field"; it is "show what needs attention and where to
act next."

The current surface already keeps Work Board out of primary navigation, which is correct.
P6 should make the page itself more understandable without changing that IA.

### Detailed Design

- Preserve Work Board as a Settings workspace tool and contextual entry.
- Keep the existing scopes, filters, and work item domain logic.
- Make the default view answer:
  - what needs action now;
  - what is blocked and why;
  - what is just history;
  - where the user can open the source context.
- Keep filters compact. Advanced filters should not dominate the first screen when no
  filter is active.
- Use product labels for scope and status copy. Internal source or waiting reason names
  can appear in details, not as the main row explanation.
- Detail pane should always have one obvious next action, even when that action is "open
  source context" or "nothing to do".
- Empty state should say "no active work" rather than imply the user should create work
  from the board.

### Acceptance Criteria

- Default Work Board first screen reads as an action review surface, not a raw status
  database.
- Filtered empty states explain whether no work exists or the current filter hides it.
- Work Board remains absent from primary navigation.
- Existing claim, heartbeat, release, complete, fail, route, and open-context actions
  continue to work.

## Priority 3: Model Workbench Beginner Setup Path

### Problem

Model Workbench is now structurally healthier, but it is still a dense configuration
surface. A new user mainly needs to know:

- can I chat;
- can I generate images;
- what key or route is missing;
- what does a successful check actually prove.

Those questions should be answered without forcing the user to understand provider
transport, adapter, route, capability, or check semantics first.

### Detailed Design

- Keep Model Workbench as the place to configure providers and routes.
- Add a beginner-facing readiness summary above or near the provider list:
  - Chat ready;
  - Image generation ready;
  - Needs key or route;
  - Disabled routes.
- Keep advanced provider details visible in rows and editor panels, but make the first
  screen outcome-based.
- Explain check results in product language:
  - configuration check passed;
  - check does not create real images;
  - generation happens from Generation tasks;
  - missing key or unsupported adapter explains exactly where to fix it.
- Preserve route distinction for the same model across multiple base URLs.
- Keep bulk discovery/import controls, but make empty/no-result states say whether the
  issue is search, provider response, unsupported discovery, or missing setup.

### Acceptance Criteria

- A first-time user can see whether chat and image generation are usable without opening
  every provider row.
- OpenAI Images and Seedream readiness does not require understanding adapter language.
- Check success copy does not imply that a real image was generated.
- Multi-route provider rows remain distinguishable.

## Priority 4: Conversation, Channel, And Private-Chat Interaction Details

### Problem

Conversation surfaces are high-risk because normal conversations, channel conversations,
and AI teammate private chats share visual patterns but have different product meanings.
P6 should not merge these shells. It should fix only concrete interaction discomfort.

### Detailed Design

- Do not refactor conversation shell ownership.
- Audit only visible first-screen and composer interactions:
  - empty-state copy;
  - blocked model/provider states;
  - disabled reason visibility;
  - menu icon/text alignment;
  - attachment, stop, retry, and guidance controls;
  - popover placement and overflow;
  - dark-mode hardcoded surfaces.
- Preserve surface semantics:
  - normal conversation is the personal Ling Agent workspace;
  - channel conversation is durable team/channel work;
  - private chat is one teammate's direct workspace.
- If a visual pattern is shared, extract only the smallest presentation piece. Do not move
  message or composer state into a generic conversation mega-component.

### Acceptance Criteria

- Channel and private chat do not inherit misleading copy from normal conversation.
- Composer controls show stable disabled/loading feedback.
- Menus and popovers do not cover or shift the message surface unexpectedly.
- No broad refactor lands in `WorkspaceClientView`, `ConversationHome`, or teammate
  private chat surfaces under this priority.

## Hard Stops

- No backend API, database, provider runtime, generation resolver, scheduler, or work item
  state-machine changes.
- No new `ViewId`.
- No Work Board promotion to primary navigation.
- No global palette or marketing-style redesign.
- No mobile acceptance scope unless reopened explicitly.
- No major behavior added to already-large files without extraction.

## Validation Standard

Every P6 implementation slice must include:

- desktop browser evidence from the served artifact being changed;
- `1440x960` and `1280x800` checks for the touched surfaces;
- no document/body horizontal overflow;
- focused e2e for the touched feature;
- dark-mode coverage when visual structure changes;
- evidence recorded back into the implementation plan.
