# GStack source producer review

## Current source-only binding, 2026-10-26

Commit `6b2a53dd` repairs failure staging ownership. The source builder hashes
itself, so its recipe changes even though the generated file contents do not.
The previous receipt below remains historical; it does not authorize the new
recipe by metadata substitution.

An actual fixed-object fetch/render ran under the original local-bounded root
and managed lease. The original builder and the preview's strict production
verifier both checked the real source generation. Its exact identities are:

- Manifest: `sha256:46d0b73ac3efa12039ea2332f03782b9d940cdd47c3798bf99cd75406166f866`.
- Recipe: `ling-35d2bce87d68a986b352980d196e383a1ed1ea9bc6684d7edcc5d5a2ca64be5c`.
- Fixed upstream remains `47d639abffa882b8cbb641d7d1dedf08ecada9ec`.
- All 3,714 file records, all 57 skills, and the entire manifest except the
  recipe field equal the previous actual manifest. No metadata recovery ran.
- Parent result: actual exit 0, 20,162 ms, direct child closed/exit 0, POSIX
  process group absent, output settled, lease released.

Evidence is under
`output/e6-20260928/p5-merged-input-review-20261026/source-recipe-preview-run-v3/`:
`actual-manifest.json`, `packet.json`, `comparison.json`, `build.log`, and
`managed-result.json`. Independent review rehashed the manifest, recipe and all
212 frozen inputs, deeply compared the complete manifests, and verified the
command/policy checksums and real settlement receipt. The source itself was
verified during the actual child execution; the independent reviewer did not
claim to rehash file bytes after the managed owner released that scratch.

The v2 preview's omitted `expectedSkillIds` caused a real strict rejection.
Its failure log/receipt and the earlier static report are preserved; the v3
delta report explicitly corrects that static omission. The production verifier
was not weakened. This binding admits only source for subsequent candidate
builds, not native artifacts, licenses, browser execution, packaged GUI or
release. It does not amend Office approval or replace remaining acceptance.

## Historical source review, 2026-10-23

The previous receipt (`2921f0cf…`, adaptation `0713f441…`) was introduced together
with the source producer in commit `d8c1cb4d`. Its producer inputs are not
available as an earlier Git revision, and the committed producer does not
reproduce that receipt. Old compiled resources do not inherit this review.

The current `render-upstream.ts`, `build-source-bundle.mjs`, and
`upstream-lock.json` were independently inspected before updating the source pin.
Review covered the exact upstream revision/version/template inventory, generated
Ling host declarations, complete tracked source inclusion, isolated rendering
environment, source alias containment, and strict generated-file inventory.

Two independent fresh fetch/render operations at upstream
`47d639abffa882b8cbb641d7d1dedf08ecada9ec` produced byte-identical manifests:

- Manifest: `sha256:25e50f1790d789b85d7c99f808a41726f922029b5f8a92874383c9912fc0a384`
- Producer inputs: `ling-deed66429fe06b1c16cc8e1af39c56467afd44aab233a3653ae2f102df923831`
- Strictly verified source files: 3,714; fully rendered specialist skills: 57.

The independent reviewer rehashed and verified every listed file in both
generations with `verifyBundledSkillSource` and independently recomputed the
producer-input digest. This admits the current **source generation** for further
development-candidate builds. It does not approve native artifacts, licenses,
redistribution, installed-client acceptance, or a formal release. Those receipts
continue to state `releaseEligible: false` and retain their pending gates.
