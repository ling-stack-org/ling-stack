# Image helper validation

Origin: the reviewed external candidate has been integrated into Ling Stack. Read
this before claiming compatibility. The repository build records source, binary
and notice digests in `dist/native/image-sanitizer/build-metadata.json`; raw candidate
and repository validation logs remain in this chat's external evidence folder.
The 144 source, dependency, fixture and license files match the final candidate byte
for byte (`native-image-repo-candidate-comparison.json`).

## Verified locally

Platform: macOS 26.6.2 arm64; rustc/cargo 1.95.0; Node 22.22.3. Debug and release
Rust suites cover 17 tests: one output bound, one isolated allocation budget test,
15 image/protocol integration tests. Release build and independent fixture
comparison logs are retained with the candidate; the repository suites are rerun separately. This is helper acceptance on one host,
not packaged desktop, Windows or macOS x64 acceptance.

PNG/JPEG/WebP decode to actual pixels; baseline/progressive JPEG, lossless/lossy
WebP, Adam7 PNG, grayscale and alpha are exercised. EXIF directions 1–8 include
mirrors, with independent sharp-generated expected pixels and a separately
handwritten pixel-position map. Damaged PNG CRC/Adler/stream length, APNG, animated
WebP, RIFF mismatch, JPEG scan-internal truncation plus forged EOI, excess entropy,
invalid scan/restart pad bits and trailing bytes are rejected. A valid progressive
stream can omit an entire optional refinement scan and end at a legal EOI; that
case is distinct from scan-internal truncation and is accepted.

Processing failure exits 2/3/4 without stdout; successful output contains only
IHDR/IDAT/IEND PNG chunks. Input/output 25 MiB, 32 million pixels, stricter pixel
argv, fixed stderr and the 512 MiB requested-live-heap budget are exercised. The
budget is not a kernel RSS or stack limit. Deadline/cancellation and safe artifact
publication are the Node caller's responsibility and need its integration tests.

## Color behavior and independent references

The previous sharp 0.34.5 installation generated synthetic 3×2 fixtures and decoded
reference pixels. The external `fixture-generation.json` records generator digest, codec versions,
options, input hashes and reference pixels. `fixtures/golden/provenance.json` binds
the original 24-direction module. No user images or account data are used.

Embedded ICC is now processed, not merely removed: RGB and gray samples and original
CMYK components pass through bounded moxcms 0.9.1 Perceptual transforms to its sRGB
profile; alpha remains separate. PNG iCCP inflate must finish exactly, JPEG APP2
parts must be complete/unique/in order after assembly, and WebP ICCP is bounded.
Oversized or malformed profiles fail; the limit is 4 MiB, 1024 tags, 4 MiB CLUT and
40,000 TRC entries. No file/URI is followed. Metadata is then discarded.

Measured maximum absolute differences against independent sharp/LCMS references:

| Fixture | Difference | Interpretation |
| --- | ---: | --- |
| PNG/WebP, 16 sRGB-ICC direction fixtures | 1 | CMS rounding; directions correct |
| JPEG 4:4:4, 8 sRGB-ICC directions | 2 | Codec plus CMS rounding; directions correct |
| Gray JPEG | 0 | Exact gray samples |
| Display P3 PNG/JPEG/WebP | 2 / 1 / 2 | Actual ICC→sRGB; prior profile stripping differed by 114 |
| Display P3 alpha PNG | ≤2 | Alpha must match exactly |
| ICC CMYK JPEG | 21 | Actual profile conversion; different CMS LUT reconstruction |
| Unprofiled CMYK against implicit sharp printing profile | 114 | Deliberately no implicit profile; conventional CMYK formula |
| Tiny high-contrast JPEG 4:2:0 | 61 | Codec chroma reconstruction differs; no pixel identity promise |

For ICC CMYK, the 24 decoded CMYK source bytes match independent
`sharp(...).pipelineColourspace('cmyk').toColourspace('cmyk').raw()` exactly. Thus
the remaining difference occurs in color management, not decoding, inversion or
lost K. moxcms documents trilinear/quadlinear interpolation for LAB/XYZ connections
(`src/transform.rs`); requesting tetrahedral or floating-point precision does not
make this profile match LCMS. Both use Perceptual intent. Rust tests bound the
observed difference at 21 and preserve six color-patch channel relationships;
the reference printing gamut itself maps saturated green toward yellow.

For CMYK without an embedded ICC, C/M/Y/K use the conventional
`RGB=(255-C/M/Y)*(255-K)/255` conversion. This avoids inventing a printing profile.
The standalone public fixture JSON carries this independent canonical expectation
and retains the old sharp printing-profile reference for transparency. The caller
has accepted different CMS reconstruction, not exact CMYK/LCMS numeric equivalence.

`../../test/fixtures/native-image-color-golden.json` provides 15 separate inputs and explicit expected pixels,
maximum difference, ICC, format and direction metadata. It does not replace the
existing Node fixture module. Formal Rust tests use local fixture bytes and raw
reference files; external-path scripts are evidence/preparation only.

## Dependencies and source integrity

18 actual active Cargo runtime/build versions: 16 select MIT, moxcms and pxfm select
BSD-3-Clause. Full license files and SHA-256 are retained in `licenses/` and the
inventory, with combined and source-level notices in `THIRD_PARTY`. Cargo.lock also
mentions optional zlib-rs; it is absent from the actual normal/build graph and
compilation. No policy allowlist is changed. The inventory is not an all-platform,
Rust-toolchain or system-library SBOM.

Only `vendor/jpeg-decoder/src/huffman.rs` differs from the verified 0.3.2 source.
The original crate digest, upstream git commit and exact local patch digest are
preserved in `upstream-provenance.json`; `STRICT-PATCH.md` explains why real entropy
bits must be distinguished from synthesized lookahead. Upstream emits eight
compile-time asmjs cfg warnings; they are not helper runtime output.

## Remaining acceptance

The Node bridge verifies a regular executable at the fixed resource path, bounds
both pipes, enforces the five-second deadline and AbortSignal, and accepts output
only after exit 0 plus close. Cancellation/overflow kill the helper; absent close
within the additional two-second cleanup window fails without publication.
Publication uses the existing safe-files module. Build metadata records digests;
the bridge does not claim runtime digest verification or post-signing attestation. The helper
accepts no path and writes no files. Windows/macOS x64 compilation, app resource
layout, signing/notarization, packaging and end-to-end artifact import require
separate evidence on their actual targets.
