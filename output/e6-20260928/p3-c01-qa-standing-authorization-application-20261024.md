# P3 C01/offline isolated QA authorization application

The user's direct standing instructions are `批准，不用再问我了` and
`批准，不发布，只验证`. This application covers necessary reviewed internal
QA only; it does not claim new human identity authentication or release approval.

- Reviewed source checkpoint: `c9e3d5811866bd636cc69f6a32244ec1e09c0f35`.
- Pending packet: `office-human-qa-p3-c01-delta-frozen-20261024.json`.
- Packet SHA256: `afe6e7fad9056f1794ae67d6dd5624fd8839c6e6b8ca28185b156fe8179d102d`.
  It remains `approved=false, approval=null`; its generator cannot mint approval.
- Previous formal manifest SHA256:
  `358fdf79b12bff5c0dbb96f07bac0fcd84435aa4dcd89a1704189836d69b82b8`.
- Applied formal manifest SHA256:
  `3d2224115472769f1287e1f1f533776677ee11527224ae87a8a2f2bd4c674ecb`.

Only the two exact independently reviewed packaging hashes for Run orchestration
and offline web prefetch changed. No added/removed inputs; all 15 native inputs,
the other 1601 packaging inputs and actual compiler/SDK/headers/Electron/signing
tuple remain identical. The original production reader accepted 15/1603, actual
exit0. No reader/guard was changed. The packet separately pins all eight reviewed
UI/test inputs, three independent review reports and 2/28/197/120 regression logs.
The unchanged baseline retains its prior full-content review; these inputs were
not all reread anew. Source checkpoint includes the offline 21/21 review evidence.

This authorizes only the original HUMAN_QA packaging lane and existing isolated
profile/workspace/port17928. Do not repair historical Run/Task rows, relax lineage,
replay old failed work or treat the build as GUI acceptance. New offline and real
two-required-participant cases must be verified on the new package, followed by
the remaining recovery/delegation/Office matrix. H09 hard cap remains unproved;
no pilot, shared CPA change, CI re-enablement, Windows test or publication.
