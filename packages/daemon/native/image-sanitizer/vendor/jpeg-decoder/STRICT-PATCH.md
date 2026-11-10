# Strict entropy boundary patch

Origin: jpeg-decoder 0.3.2, image-rs/jpeg-decoder commit
`eb2d7c0f6a2d0298aba7a7f8b9ca1440353e8f8c` (published .cargo_vcs_info.json).
Original crate SHA-256 is recorded in `upstream-provenance.json`.
The original MIT and Apache-2.0 license texts are retained; this distribution elects MIT.

Only `src/huffman.rs` differs from the reviewed published source. The patch tracks
how many buffered bits came from the input rather than synthesized zero lookahead.
Lookahead remains allowed. Consuming any synthesized bit fails at the next scan or
restart boundary. At such a boundary, unconsumed real data must be at most seven
all-one padding bits, as required by JPEG entropy coding. This also rejects extra
entropy bytes following the required MCU data.

The upstream decoder otherwise successfully decoded synthetic baseline JPEGs
truncated by 5, 10, 20 and 30 bytes and progressive JPEGs truncated within scans by
5 and 10 bytes when EOI was appended. Regression tests preserve this failure mode. New tests
also independently construct minimal legal entropy streams, including RST0, and
reject invalid pad bits.

Removing an entire final progressive refinement scan and appending EOI at a legal
marker boundary can produce a valid lower-precision image. The helper accepts this
case: bytes alone cannot distinguish it from an intentionally abbreviated progression.
This is covered separately from scan-internal truncation and does not consume synthetic bits.

This is a local source modification for Ling Stack, not an upstream release or an
assertion of exhaustive JPEG conformance. Container validation, resource bounds,
fresh PNG encoding and process cancellation remain the helper/caller's responsibility.
