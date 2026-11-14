# Model Workbench CPA-style presentation plan

Status: implemented in the follow-up to PR #699.

## Reference

The local CPA supplier surface at `/Volumes/codex/workspace/中转站/chatgpt-price-board/apps/web/src/pages/Vendors/` uses a compact summary-first flow: one primary add action, one supplier summary surface, and `<details>`-based progressive disclosure for editing, catalog state, and diagnostics.

## Scope

Apply the same interaction hierarchy to Ling's model workbench without changing provider persistence, preflight semantics, default-model behavior, media capability resolution, or reference-protected deletion.

## Stages

1. Preserve the semantic table and existing selectors for accessibility and regression stability.
2. Present populated model routes as separated card-like surfaces with one model identity, one capability group, one primary state, and the next useful action.
3. Keep advanced editor fields, model discovery, and raw provider responses progressively disclosed.
4. Validate at 1440×960 and 1280×800 in light/dark themes, then run the existing model-workbench and productization suites.

## Acceptance

- A user can identify model, route, capability, status, and next action from the first viewport.
- Routine rows no longer read as a dense spreadsheet, while table semantics and keyboard actions remain intact.
- Existing check, save, import, default, disable, delete, and error-owner tests remain green.
- No new dependency, API, or daemon behavior is introduced.
