# Windows installer bootstrap review — 2026-10-10

Status: inventory and available material collected; public Windows binary distribution remains NO-GO.

The 443-component runtime inventory is separate from the installer wrapper. The complete external inventory now lists 453 installer/runtime/upstream packages, including the parent EXE. Forced NSIS extraction identified six actual plug-ins; the uninstaller uses a subset of four. Every extracted DLL matches the exact cached toolchain. StdUtils, SpiderBanner and WinShell also match original supplier archive DLLs.

NSIS vendor COPYING, Electron Builder template MIT text, StdUtils 1.14 LGPL full text and clarification, matching corresponding-source archive, subsidiary source notices, and supplier records are retained here. The corresponding source archive is 206,896 bytes.

## Questions before public binary distribution

- **WinShell**: Supplier identifies it as Freeware but does not provide complete redistribution/source-license terms; supplied archive contains binaries only. Source: https://nsis.sourceforge.io/WinShell_plug-in
- **SpiderBanner**: Matching source/binary archive and author usage statement are available, but no complete explicit plug-in license was found. Source: https://nsis.sourceforge.io/SpiderBanner_plug-in
- **nsis7z 19.00**: Shipped DLL matches the vendor resource bundle. The current supplier ZIP DLL differs; a pinned 19.00 source mirror and public-domain SDK text do not establish exact corresponding plug-in source or resolve legacy LGPL context. Source: https://nsis.sourceforge.io/Nsis7z_plug-in

Keep Windows Releases Draft while these questions remain open. Obtain applicable supplier terms/source confirmation or replace the affected installer components and perform installer acceptance before public binary approval. Source publication with Windows Releases kept Draft is a separate decision.

The notices-r1 installer embeds the original runtime material set. This companion audit adds wrapper inventory, available notices and corresponding source; it does not assert that the standalone EXE embeds every newly recovered bootstrap notice. A later public candidate must include its finalized complete materials in the product artifact. No new installation or functional acceptance is claimed.
