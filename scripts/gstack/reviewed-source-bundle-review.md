# GStack source producer review, 2026-10-23

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
