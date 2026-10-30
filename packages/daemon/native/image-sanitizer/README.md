# Image sanitizer

Product-owned codec for execution-engine image artifacts.

Protocol `ling.image-sanitizer.v1`: invoke `ling-image-sanitizer <maxPixels>` with
one ASCII decimal integer in 1..32000000. Stdin is one PNG, JPEG or WebP byte string
of at most 25 MiB; the caller must close stdin. No file paths, URIs or network
inputs are accepted. Success is exit 0 with only a freshly encoded PNG on stdout
(at most 25 MiB). Processing failures produce no stdout: exit 2 invalid, 3
unsupported including animation, 4 capacity. Stderr contains fixed tokens only;
the allocation limiter can exit 4 without stderr. I/O failure can terminate after
a partial write; callers must reject all output unless the exit status is 0.

Optional `--background` after the pixel limit selects the explicit wallpaper preset:
input <=16 MiB, <=8192 per side, <=16 million pixels (also bounded by maxPixels).
After orientation and color conversion it downsamples proportionally, without cropping
or upscaling, to <=2560 per side and <=4 million pixels, then emits a <=16 MiB PNG.
Area averaging preserves alpha through premultiplied sampling. The original single-argument
artifact protocol retains its dimensions and limits. Unknown/extra arguments are rejected.

The caller owns the 5-second monotonic deadline, AbortSignal, process termination,
bounded pipes, waiting for close, executable selection and safe artifact
publication. This helper contains no subprocess spawning or file/network reads.
The JPEG library may use internal std threads for sufficiently large images.

Container checks precede decoding and enforce dimensions, exact boundaries, PNG
CRC/zlib stream length, animation rejection and bounded TIFF IFD0 Orientation.
Images are decoded to pixels, oriented for all EXIF values 1..8 and encoded without
copying source metadata. Embedded RGB/gray/CMYK ICC profiles are transformed to
sRGB with moxcms before metadata removal. ICC input/inflate is capped at 4 MiB,
tag tables at 1024 entries, with bounded CLUT/TRC parsing and the same process budget.
PNG palette, grayscale, alpha, 16-bit downscaling and
Adam7 are supported through png's expansion transforms. JPEG is 8-bit Huffman DCT
(baseline, extended sequential, progressive); arithmetic/lossless variants are
unsupported. CMYK without a profile uses the decoder's canonical CMYK values and
the conventional unprofiled RGB conversion; no implicit printing profile is guessed.
CMS interpolation and codec reconstruction can differ from libvips/LCMS. See
`VALIDATION.md` for actual P3/CMYK and 4:2:0 differences and acceptance boundaries.

`src/budget.rs` bounds requested live heap allocations at 512 MiB and charges both
old and new requested buffers during realloc. It does not bound allocator overhead,
kernel RSS, mapped code or thread stacks. It exits the helper with status 4 on budget
exhaustion. Pixel/output bounds and the parent's deadline remain independent limits.

The vendored JPEG library has a narrowly documented strict entropy patch. Read
`vendor/jpeg-decoder/STRICT-PATCH.md`, `upstream-provenance.json` and the unified diff.
All 18 active Cargo runtime/build dependency versions have reviewed MIT or
BSD-3-Clause text; inactive
`zlib-rs` in Cargo.lock is not enabled or compiled. THIRD_PARTY_LICENSES.txt contains the selected
notices, including source-level third-party copyright notices. Feature and license
evidence is in `dependency-inventory.json`; individual texts are in `licenses/`.

Build and test with a task-local CARGO_HOME:

```
cargo test --locked -- --test-threads=1
cargo build --release --locked
```

Validation is local macOS arm64 only. Windows, macOS x64 and packaged desktop
acceptance require their own build, signature/resource and runtime checks. The
included tiny synthetic fixture bytes were generated with the previously installed
sharp 0.34.5 only for tests; sharp is not a build or runtime dependency of the helper.
`../../test/fixtures/native-image-color-golden.json` contains the additional independent
color references for the public artifact tests. Generator scripts and their input
provenance remain in this chat's external evidence folder; they are not build inputs.
The repository build script records source, binary and notice digests in
`dist/native/image-sanitizer/build-metadata.json` before Desktop signing.
