# macOS development packaging source review, 2026-11-17

This scoped source prerequisite covers the Locked Use integration in the fixed
Office packaging closure for Darwin arm64, `unsigned_dev`, ad-hoc signing and
`provider=false`.

Candidate: `b47c62345b3ed4af83ece9590d7ab2ddccfd8f38`.
Base: `27a9ccb23c59bcb890d556767f175830717b94cc`.

## Independent decision

The independent in-host Codex reviewer `/root/locked_use_adversarial` returned
`APPROVE_SCOPED_DEVELOPMENT_PACKAGING` for the exact current 60-entry delta
and found no further source finding in its re-review. This is a separate review
context on the same model host, not human or cross-model approval.

The decision permits only the 60 `packagingSha256` entries below: five updated
Desktop IPC/runtime/bridge inputs and 55 generated localization catalogs. All
other frozen-review fields, including native sources, runtime, compiler/SDK/header
profiles, deployment target, signing and trust, remain unchanged. The candidate's
1,846 fixed inputs have no extra or missing key; 1,786 match the previous record.
All 15 Office native inputs match it.

The reviewer read the current candidate and exact changed-input projection, plus
the hook/config/signer paths. Its prior complete Locked Use/native source review
remains byte-identical; tests and fixtures were summary-only for that review.

The actual esbuild `write:false` metafile for the three signing hook/config
entrypoints contains 46 authored runtime inputs, all in the fixed inventory.
Independent negative-lane checks verified that ordinary provider-free development
packaging adds no Locked Use metadata/resources, rejects supplied Locked Use
roots before reading them, and retains default ad-hoc signing and ASAR fuses.
The new signing readers perform no installation or authorization at import.

## Exact approved inputs

| Packaging input | Change | SHA-256 |
| --- | --- | --- |
| apps/desktop/main/ipc.ts | updated digest | ba447cdb732bc1d4f0fca722800482ec0935a1e558e5ca9c8ad9fe155f96c2a7 |
| apps/desktop/preload/main-window.ts | updated digest | 37b19fa8e51ac25666c4cdb005a51973f11de449b98964aa26b9a4eb90416de2 |
| apps/desktop/shared/ipc-channels.ts | updated digest | 58bea4ea7a63b9e9454f50cb294e7e2476fac62efba515f3d317b21dede4f076 |
| apps/desktop/shared/desktop-capabilities.ts | updated digest | 68e4ebe39539aa81582c567a7aa44cb90e65187e5e76829940df869b1adf884e |
| apps/desktop/main/desktop-runtime.ts | updated digest | b76e028794ab518903e2d0b22edb297bd7a3e14fed1178c9cd0e17093ba3b176 |
| packages/localization/src/generated/catalogs/bg-BG.ts | generated catalog digest | 7b4acfe76aa4f640db9c2a08f40cfcba3b2d652b1ef7e04ed5e1f5fa5e8dc9b6 |
| packages/localization/src/generated/catalogs/bn-BD.ts | generated catalog digest | 7038e04b642e4ca4da30ac7f14563366e266b4c880e51d6347a50fdaaac3efdb |
| packages/localization/src/generated/catalogs/bs-BA.ts | generated catalog digest | c8946770816b2679ef8f4790f87b231ed442cb87326be116ea0544371fa4f566 |
| packages/localization/src/generated/catalogs/ca-ES.ts | generated catalog digest | e112263f3e4c4ce5181325e759f7f3b518da98047c5c4eb4ab12e16396d4de83 |
| packages/localization/src/generated/catalogs/cs-CZ.ts | generated catalog digest | 1672898d058109ca6cba5ad6aa22c345f32af0a372837089bddef2cffde7b99b |
| packages/localization/src/generated/catalogs/da-DK.ts | generated catalog digest | e9bd73c15102478ba86c2c45688fd2b8a948a17fff8d20f49369cfcbaeb2f668 |
| packages/localization/src/generated/catalogs/de-DE.ts | generated catalog digest | cf6016e7639f69ab56672ea45db955a02bb69af405d67812b2fd0757b959d41d |
| packages/localization/src/generated/catalogs/el-GR.ts | generated catalog digest | e70bc173189d4772e279118b2e5f9ca6c578a0694724aa97c3ff9f08d659a395 |
| packages/localization/src/generated/catalogs/en-US.ts | generated catalog digest | 50d991426a6386be8eced5cbdb9a2673eb664ad475451fb75ff79db50ee3a298 |
| packages/localization/src/generated/catalogs/es-419.ts | generated catalog digest | 84f715ad5f4494df0e2c953bb1417d44072558683b4bcb5ca22502496e5a35ca |
| packages/localization/src/generated/catalogs/es-ES.ts | generated catalog digest | 6a3bba857d76e6cd6b3ec8f343c04ec45c20a8220c33650932f131db46975866 |
| packages/localization/src/generated/catalogs/et-EE.ts | generated catalog digest | 52f15bc1b84674b94e0e00dca16b0dc23afd9e55f501a053e5332662a57a3135 |
| packages/localization/src/generated/catalogs/fi-FI.ts | generated catalog digest | 397093e1af2e414096a3e92a1023006759511e902ba1e6675766c8ce96214366 |
| packages/localization/src/generated/catalogs/fr-CA.ts | generated catalog digest | 1131732cd8b8c2108603af0062a8d6c163370da085de08ff70077a080c4fb57a |
| packages/localization/src/generated/catalogs/fr-FR.ts | generated catalog digest | a866785686d8a5af9754bd064cce1a868a7a4a615014ddd0a3629d0b264b6d07 |
| packages/localization/src/generated/catalogs/gu-IN.ts | generated catalog digest | 006597732e07098def15d61a66c7e583dc996cd9dd03e7fa9aa4c0670f6d743d |
| packages/localization/src/generated/catalogs/hi-IN.ts | generated catalog digest | 6cc9b3481a730dcd3569e46faaedf667aebeb4fae5032ffdbd0cd8b8d9f061bc |
| packages/localization/src/generated/catalogs/hr-HR.ts | generated catalog digest | b101ef6730854e9db640b1925569c5f5072b21145f244edb51b62d40c45b3ba9 |
| packages/localization/src/generated/catalogs/hu-HU.ts | generated catalog digest | 164572a0a508b43b6128764b6d4dfb0c443a87ac09cfca4bdc8dd8760f3e7ff9 |
| packages/localization/src/generated/catalogs/hy-AM.ts | generated catalog digest | 7e21723433587c3de8519ac5b6a6485d8f0b17b10282f60f7686e6da667a5f5c |
| packages/localization/src/generated/catalogs/id-ID.ts | generated catalog digest | 5f991100e4042dce3e732a224dd9fa05fb4b7c35ad509dc55c8b64b53616db48 |
| packages/localization/src/generated/catalogs/is-IS.ts | generated catalog digest | 3aad715b1d489dee6a61c8e5a86e2af53426d44cece7fb62507a31501a007081 |
| packages/localization/src/generated/catalogs/it-IT.ts | generated catalog digest | d2e6d8f845091e11e30265937e4b00e4e58e471afed59bae8648fcb34919aba0 |
| packages/localization/src/generated/catalogs/ja-JP.ts | generated catalog digest | 0ed5bc3f8e5e2927c6b107cdb4d710478322dc0a8cdb0005910e4c40e89f8edd |
| packages/localization/src/generated/catalogs/ka-GE.ts | generated catalog digest | 59a61f95a6d64b59df3f580cf8fa3b9ba604840c2ee02f727a4f2458325566a6 |
| packages/localization/src/generated/catalogs/kn-IN.ts | generated catalog digest | 6ee7060b188d9dd55ddb7f91e9fffb0dcd6d20ca2e1afe32bc83bb7f28741e81 |
| packages/localization/src/generated/catalogs/ko-KR.ts | generated catalog digest | 49a05774c60bc27c8703f4a8cac3a84fe6796e214b58f83117e9507fcd8f6a36 |
| packages/localization/src/generated/catalogs/lv-LV.ts | generated catalog digest | 30f94b9712ce1fccb798b35605600ae444a05a6199144ccce683b19ea06df0e1 |
| packages/localization/src/generated/catalogs/mk-MK.ts | generated catalog digest | 0705180688882c524aeaa73af5b79654421b363c3d5466adef2631e0a24a08c5 |
| packages/localization/src/generated/catalogs/mr-IN.ts | generated catalog digest | 50dca8ce89deec427729c17debee654f8aa1323f6e5e08598aa1f3a297cba665 |
| packages/localization/src/generated/catalogs/ms-MY.ts | generated catalog digest | 734fe565e9035e3e405b6d6ab997b555953443676e8ffea64a6ba7e11c9cae48 |
| packages/localization/src/generated/catalogs/my-MM.ts | generated catalog digest | 26fc26de42c2a4186e296e6e9883eac24044f0f0080fa85e20942c8d4b012d0d |
| packages/localization/src/generated/catalogs/nb-NO.ts | generated catalog digest | 4b76f4b6e185241699ad1497a91b9d18ea1eb13dce09275f0c1543cb074547a4 |
| packages/localization/src/generated/catalogs/nl-NL.ts | generated catalog digest | a7114168161f59253b09cf2fb2f6cceaa1d8d2f1c96e3b6eea4f33e162b1ec46 |
| packages/localization/src/generated/catalogs/pl-PL.ts | generated catalog digest | 160db109009bd579c67d279349f6fa4fedafb6e6def7e9fbc594b6ca6f6f93cd |
| packages/localization/src/generated/catalogs/pt-BR.ts | generated catalog digest | 6a8619f5e79fdf1a506af5f5dded0f89f8cabb90dd432b24492d0e48696e6c64 |
| packages/localization/src/generated/catalogs/pt-PT.ts | generated catalog digest | 66ec7eacb78f007b6905582e6ef39141c1dc84ec2dc5684e1c42108ad1d026a8 |
| packages/localization/src/generated/catalogs/ro-RO.ts | generated catalog digest | ebc2ce0f2abd90566713475915a85e37914bcf64780e79a54a8d6898cba01f29 |
| packages/localization/src/generated/catalogs/ru-RU.ts | generated catalog digest | 577b8a06516601f8db7ec9621f5b1dd4044d9cf99e0fe92307fcdd9afc174ca9 |
| packages/localization/src/generated/catalogs/sk-SK.ts | generated catalog digest | f070cb24202e4cdbc0d24a3c02432d8d407f378607077acada33b6eb5fa6fd72 |
| packages/localization/src/generated/catalogs/sl-SI.ts | generated catalog digest | 7fc66eb0d4a6b3dbd1d9e3e22a0c5b8b88b0f5805438511c7b55890ea15c7d6c |
| packages/localization/src/generated/catalogs/so-SO.ts | generated catalog digest | 5884c87d124a0328fbf8560a0979e1650cc99ed5b271f47cc78bb176f9bd5462 |
| packages/localization/src/generated/catalogs/sq-AL.ts | generated catalog digest | 5b69a1c816e98d4112fef37cea46583a3b9306ee766eeb9d44de299e59ca1840 |
| packages/localization/src/generated/catalogs/sr-RS.ts | generated catalog digest | f8e660f9fb4e64181f9b89761d5e557428731c8638f5d4d23f99f707a294f3fa |
| packages/localization/src/generated/catalogs/sv-SE.ts | generated catalog digest | fb5f639aa20df8c6b29e89e0da5fb7b0ae5be98441e258c4f4810ebe3bdaff6c |
| packages/localization/src/generated/catalogs/sw-TZ.ts | generated catalog digest | ebb74955f98f6105539e9e2902a30bdde6925e5f6f8a04bb84a47fdc5b16d537 |
| packages/localization/src/generated/catalogs/ta-IN.ts | generated catalog digest | a658ff76d2a5ae24fcec287479c6290b610e52a5e5913f03454b3c16bf21517b |
| packages/localization/src/generated/catalogs/te-IN.ts | generated catalog digest | daaf77ca321d4c3e5a44a44b440e15cdd6778602fe6aef0be012e245964b8c76 |
| packages/localization/src/generated/catalogs/th-TH.ts | generated catalog digest | c3dfdbff96c682663bdc324a16d8d6357ced7d3c8de56ac4e5bc19bcc0210729 |
| packages/localization/src/generated/catalogs/tr-TR.ts | generated catalog digest | 3276a772ce8e3b4ba39759771d53e608219c4808f8400f0999f16e73eb24febf |
| packages/localization/src/generated/catalogs/uk-UA.ts | generated catalog digest | 72f525b270626c96b221bbf9185641135197c5945d05cd34c6ba0bb2e13a9b59 |
| packages/localization/src/generated/catalogs/vi-VN.ts | generated catalog digest | 589396c2036bf86eb6d1729cc52d6b96d98431219a981376ae668bdff197a0cd |
| packages/localization/src/generated/catalogs/zh-CN.ts | generated catalog digest | daa12cf235682acb61e03254561bf4cee06fe89164b161d122e7485d22f590c0 |
| packages/localization/src/generated/catalogs/zh-HK.ts | generated catalog digest | 2187cca4b8e45fa1bfd1d652e016356f6e54a106317bb8becccc5a97946b61f1 |
| packages/localization/src/generated/catalogs/zh-TW.ts | generated catalog digest | 374abb59e1d6b1a8de211659edb1f10f19f915b80af02c1ef0d6a66dea964137 |

The previous adopted review record SHA-256 is
`efe75d3af7195c9b5f6edf62f14af7a25aa197a78f2273397f98f3e3fe7e53ce`.
The adopted record SHA-256 is
`448845d5c6b59feb77ecf7f632a41698de98c0f6c44a257231307fdbdd6d5fc6`.
The full 1,846-input aggregate is
`8beae6c4fafdbda41a1b0c52b51fdb93735ec0c209aae1ca67f66914410e0e6e`;
the 60-input delta aggregate is
`5443dfe12ac6a47b09540d62bb881ca0ca366453e419ebb7c1712a15cf55ec18`.
Aggregates encode compact JSON `[path, sha256]` pairs in
`PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS` order plus one LF.

## Validation and limits

The final focused Desktop/Locked Use/provider selection passed 108/108 tests
after the authorization-boundary fix. Desktop `typecheck:ci` passed all five
TypeScript projects; the reviewer independently re-ran the main/test typechecks,
40 focused cases, localization checks and `git diff --check`. The 55
localization catalogs and their 24 checks passed, and the existing web validation
remains 1,338/1,338 unit tests plus 17/17 Computer Control Playwright cases.
The focused signing/hook/publication/QA-lane selection passed 1,888/1,888 tests
with no skips, including the real frozen input-digest check. Its compiler/signature
fixtures are synthetic and do not attest an actual App.

This source decision does not accept a final App, ZIP or DMG, change the existing
reviewed runtime/toolchain constraints, or certify signing, notarization, public
binary distribution, GUI behavior, native installation or a real provider.
Missing release prerequisites remain enforcing checks.

The read-only native preflight reports not-installed and ready=false, with
missing installed components, Client approval, authentication policy and Guardian
permissions. Administrator installation and permission grants have not occurred.
Attended capture/input/Keychain, relock/manual unlock, physical display coverage,
takeover and fault-matrix acceptance remain incomplete. Apple Development native
fixture evidence cannot qualify the production Desktop/provider lane. Locked Use
therefore remains `disabled_by_build`, and Pre-Landing Review is INCOMPLETE.
