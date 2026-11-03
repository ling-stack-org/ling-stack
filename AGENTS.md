# Ling Stack Agent Instructions

## Testing

Follow the [Testing Policy](CONTRIBUTING.md#testing-policy) for all new or changed tests.

- Prefer TypeScript for new JavaScript/TypeScript-module tests and test helpers.
  Ensure the owning runner discovers them and the package's validation commands and
  relevant CI gates type-check them. File renames or runtime transpilation alone are
  insufficient. Document concrete runtime or compatibility exceptions for JavaScript.
- Migrate existing `.mjs` tests incrementally when maintaining their owning module;
  preserve coverage and test discovery, and avoid unrelated bulk conversions.
- Prefer behavior and boundary assertions over implementation-text matching. Preserve
  independently valuable security, architecture, and other declared contract checks.
- Require evidence before consolidating or removing tests. Never delete tests to
  reduce the JavaScript share or rewrite production code in Rust for that purpose.

## Validation

Run the narrowest relevant tests and the owning package's typecheck for test changes.
For documentation-only changes, use the checks in
[Contributing: Validation](CONTRIBUTING.md#validation). Report checks actually run and
any platform or runtime acceptance that remains unverified.
