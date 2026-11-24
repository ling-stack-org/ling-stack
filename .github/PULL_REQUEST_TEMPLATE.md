## Summary

Describe the problem and the user-visible outcome.

## Scope

- Areas changed:
- Explicitly unchanged:
- Related issue or design contract:

## Validation

List the exact commands and manual checks that ran. Do not mark unrun checks as passed.

```text
command -> result
```

## CI Scope

Record the mode (`docs`, `affected`, or `full`), its reason, and the required jobs
and platforms or a link to the scope report. Note whether the scope fits or needs
a fix or follow-up. See the [PR CI review procedure](../docs/maintenance/ci.md#pr-ci-范围检查).

## Product And Visual Evidence

For visible UI changes, include screenshots for the relevant light/dark, loading, empty,
error, focus, and overflow states. Remove this section when it does not apply.

## Risk And Compatibility

Describe permission, security, secret, storage, migration, API, provider, platform, and
backward-compatibility impact. Write `None` only after checking each category.

## Checklist

- [ ] The change is focused and follows existing module boundaries.
- [ ] Tests cover the changed behavior or the missing coverage is explained.
- [ ] New or migrated tests follow the [testing policy](../CONTRIBUTING.md#testing-policy): TypeScript tests are executed and type-checked, or a concrete JavaScript exception is explained.
- [ ] Test consolidation or removal has supporting coverage and validation evidence; independent safety and architecture contracts remain protected.
- [ ] Chinese and English product copy remain aligned when applicable.
- [ ] Documentation and implementation status are updated when applicable.
- [ ] No credentials, tokens, local databases, logs, artifacts, or private paths are committed.
- [ ] No test, approval, security, or release gate was skipped or weakened to make this pass.
