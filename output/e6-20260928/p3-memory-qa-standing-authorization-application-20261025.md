# P3 project-input/Memory isolated QA authorization application

The user's direct standing instructions are `批准，不用再问我了` and
`批准，不发布，只验证`. This applies that existing authorization to exact
reviewed internal QA inputs. It does not assert fresh human authentication,
approve a formal release, or change the production review reader.

- Implementation checkpoint: `b3c1937cd8fb5dac8515ca0d2249a23ff959a876`.
- Pending packet: `office-human-qa-p3-memory-delta-frozen-20261025.json`.
- Pending packet SHA256:
  `c3c626c76906c98b0e407b3c43696171381d127cca26b04e59bad79557c7f714`.
  It remains `approved=false, approval=null`; its generator never grants approval.
- Previous formal manifest SHA256:
  `3d2224115472769f1287e1f1f533776677ee11527224ae87a8a2f2bd4c674ecb`.
- Applied formal manifest SHA256:
  `e29a856fa977ab065936b2a621e063cd71d306319743193ae66e8601046fddd8`.

Only 24 exact packaging hashes and 2 added source-input keys change. All 15
native inputs, other 1579 packaging inputs, and compiler/SDK/headers/Electron/
signing tuple remain identical to the prior reviewed record. There are no removed
inputs. Every changed/added input has an exact path/hash row in the packet's
three independent reports; unchanged input content inherits the previous frozen
full-content review. This is a delta review, not a claim that all 1605 inputs were
newly reread. Four reviewed Web renderer/controller inputs are pinned separately.

The original reader must accept the applied manifest before packaging. Use only
the original HUMAN_QA arm64/ad-hoc lane, existing isolated profile/workspace and
port17928. Do not repair historical database facts or replay old failed tasks.

The final full Daemon regression is a separate live run with its own before/after
source/candidate fingerprint. This record does not mark it passed. New package
exit/readback, full two-required-participant C01, recovery/delegation/Office GUI
and H09 remain open. No publication, Windows acceptance, global GStack upgrade,
CI re-enablement or new human identity assertion is authorized by this record.
