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

For new Node.js or TypeScript workspace modules, follow the
[workspace CI contract](docs/maintenance/ci.md#新模块接入-ci). Declare workspace
dependencies in the consuming manifest and keep CI entrypoints aligned with
test discovery and type checking.

## Pull Request CI

Before opening or reviewing a pull request, check CI against the entire diff from
its target branch. Confirm that the validation covers the changed packages,
affected consumers, and required platforms. Investigate `full` runs for unrelated
jobs and retain full regression when the impact is broad or uncertain.

Record the scope decision and evidence in the PR. Preserve required checks and
applicable dependency, security, native, and release validation when narrowing
scope. Follow the [PR CI review procedure](docs/maintenance/ci.md#pr-ci-范围检查).
