use ling_image_sanitizer::{Error, MAX_BYTES};
use std::io::{Cursor, Write};
use std::process::{Command, Stdio};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}
fn run(bytes: &[u8], max_pixels: &str) -> std::process::Output {
    run_args(bytes, &[max_pixels])
}
fn run_args(bytes: &[u8], args: &[&str]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ling-image-sanitizer"))
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(bytes);
    child.wait_with_output().unwrap()
}

#[test]
fn background_preset_resizes_but_artifact_protocol_retains_original_dimensions() {
    let mut input = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut input, 4096, 8);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![127; 4096 * 8 * 4])
            .unwrap();
    }
    let original = run(&input, "16000000");
    assert_eq!(original.status.code(), Some(0));
    assert_eq!(
        (decode(&original.stdout).0, decode(&original.stdout).1),
        (4096, 8)
    );
    let background = run_args(&input, &["16000000", "--background"]);
    assert_eq!(background.status.code(), Some(0));
    assert_eq!(
        (decode(&background.stdout).0, decode(&background.stdout).1),
        (2560, 5)
    );
    for args in [
        ["16000000", "--unknown"].as_slice(),
        &["16000000", "--background", "extra"],
    ] {
        let output = run_args(&input, args);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}
fn decode(bytes: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut reader = png::Decoder::new(Cursor::new(bytes)).read_info().unwrap();
    let mut out = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut out).unwrap();
    out.truncate(frame.buffer_size());
    assert_eq!(frame.color_type, png::ColorType::Rgba);
    (frame.width, frame.height, out)
}
fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(body.len() as u32).to_be_bytes());
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v.extend_from_slice(&crc32fast::hash(&v[4..]).to_be_bytes());
    v
}
fn tiff(direction: u8) -> Vec<u8> {
    let mut v = vec![
        0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, direction, 0, 0, 0, 0, 0,
        0, 0,
    ];
    v.shrink_to_fit();
    v
}
fn webp_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(kind);
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    if body.len() % 2 != 0 {
        v.push(0);
    }
    v
}
fn exif_image(bytes: &[u8], format: &str, direction: u8) -> Vec<u8> {
    let exif = tiff(direction);
    match format {
        "png" => [&bytes[..33], &chunk(b"eXIf", &exif), &bytes[33..]].concat(),
        "jpg" => {
            let mut body = b"Exif\0\0".to_vec();
            body.extend_from_slice(&exif);
            [
                &bytes[..2],
                b"\xff\xe1",
                &((body.len() + 2) as u16).to_be_bytes(),
                &body,
                &bytes[2..],
            ]
            .concat()
        }
        "webp" => {
            let alpha = bytes[12..16] == *b"VP8L" && bytes[24] & 0x10 != 0;
            let vp8x = webp_chunk(
                b"VP8X",
                &[
                    0x08 | if alpha { 0x10 } else { 0 },
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    2,
                    0,
                    0,
                ],
            );
            let mut v = [
                &bytes[..12],
                &vp8x,
                &bytes[12..],
                &webp_chunk(b"EXIF", &exif),
            ]
            .concat();
            let size = (v.len() - 8) as u32;
            v[4..8].copy_from_slice(&size.to_le_bytes());
            v
        }
        _ => panic!(),
    }
}
fn expect_error(bytes: &[u8], code: i32) {
    let output = run(bytes, "32000000");
    assert_eq!(
        output.status.code(),
        Some(code),
        "stderr={:?}",
        output.stderr
    );
    assert!(output.stdout.is_empty());
    assert!(
        output.stderr == b"invalid_artifact\n"
            || output.stderr == b"unsupported_artifact\n"
            || output.stderr == b"capacity_exceeded\n"
            || output.stderr.is_empty()
    );
}

#[test]
fn real_decoding_formats_and_progressive_variants() {
    for name in [
        "source.png",
        "source.jpg",
        "source.webp",
        "progressive.jpg",
        "interlaced.png",
        "grayscale.png",
        "alpha.png",
        "lossy.webp",
    ] {
        let output = run(&fixture(name), "32000000");
        assert_eq!(
            output.status.code(),
            Some(0),
            "fixture={name}; stderr={:?}",
            output.stderr
        );
        assert_eq!(decode(&output.stdout).0, 2);
        assert!(output.stderr.is_empty());
    }
}
#[test]
fn all_eight_orientations_across_three_containers() {
    let orders: [&[usize]; 8] = [
        &[0, 1, 2, 3, 4, 5],
        &[1, 0, 3, 2, 5, 4],
        &[5, 4, 3, 2, 1, 0],
        &[4, 5, 2, 3, 0, 1],
        &[0, 2, 4, 1, 3, 5],
        &[4, 2, 0, 5, 3, 1],
        &[5, 3, 1, 4, 2, 0],
        &[1, 3, 5, 0, 2, 4],
    ];
    for format in ["png", "jpg", "webp"] {
        let base = fixture(&format!("source.{format}"));
        let output = run(&base, "32000000");
        assert_eq!(output.status.code(), Some(0), "base={format}");
        let (_, _, pixels) = decode(&output.stdout);
        for direction in 1..=8 {
            let input = exif_image(&base, format, direction);
            let output = run(&input, "32000000");
            assert_eq!(
                output.status.code(),
                Some(0),
                "format={format}; orientation={direction}; stderr={:?}",
                output.stderr
            );
            let (w, h, out) = decode(&output.stdout);
            assert_eq!((w, h), if direction >= 5 { (3, 2) } else { (2, 3) });
            let expected: Vec<u8> = orders[direction as usize - 1]
                .iter()
                .flat_map(|i| pixels[i * 4..i * 4 + 4].iter().copied())
                .collect();
            assert_eq!(out, expected, "format={format}; orientation={direction}");
        }
    }
}
#[test]
fn fresh_png_retains_no_source_metadata() {
    let source = fixture("source.png");
    let exif = exif_image(&source, "png", 6);
    let mut input = [
        &exif[..exif.len() - 12],
        &chunk(b"tEXt", b"author\0private"),
        &chunk(b"iTXt", b"keyword\0\0\0\0\0private"),
        &exif[exif.len() - 12..],
    ]
    .concat();
    let output = run(&input, "32000000");
    assert_eq!(output.status.code(), Some(0));
    let mut at = 8;
    while at < output.stdout.len() {
        let len = u32::from_be_bytes(output.stdout[at..at + 4].try_into().unwrap()) as usize;
        assert!(matches!(
            &output.stdout[at + 4..at + 8],
            b"IHDR" | b"IDAT" | b"IEND"
        ));
        at += len + 12;
    }
    // Ancillary CRC must also be checked, including metadata the decoder ignores.
    let ix = input.len() - 13;
    input[ix] ^= 1;
    expect_error(&input, 2);
}
#[test]
fn png_rejects_ancillary_crc_animation_and_truncation() {
    let source = fixture("source.png");
    let mut text = chunk(b"tEXt", b"author\0private");
    let last = text.len() - 1;
    text[last] ^= 1;
    expect_error(&[&source[..33], &text, &source[33..]].concat(), 2);
    expect_error(
        &[
            &source[..33],
            &chunk(b"acTL", &[0, 0, 0, 1, 0, 0, 0, 0]),
            &source[33..],
        ]
        .concat(),
        3,
    );
    expect_error(&source[..source.len() - 3], 2);
    let mut trailing = source.clone();
    trailing.push(1);
    expect_error(&trailing, 2);
}
#[test]
fn png_requires_exact_complete_zlib_stream() {
    let source = fixture("source.png");
    let mut idat = Vec::new();
    let mut at = 8;
    while at < source.len() {
        let len = u32::from_be_bytes(source[at..at + 4].try_into().unwrap()) as usize;
        if &source[at + 4..at + 8] == b"IDAT" {
            idat.extend_from_slice(&source[at + 8..at + 8 + len]);
        }
        at += len + 12;
    }
    for data in [
        idat[..idat.len() - 1].to_vec(),
        [idat.as_slice(), &[1, 2, 3]].concat(),
        {
            let mut bad = idat.clone();
            let i = bad.len() - 1;
            bad[i] ^= 1;
            bad
        },
    ] {
        let input = [
            &source[..33],
            &chunk(b"IDAT", &data),
            &source[source.len() - 12..],
        ]
        .concat();
        expect_error(&input, 2);
    }
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    z.write_all(&[0; 28]).unwrap();
    let data = z.finish().unwrap(); // 2x3 RGBA expects 27 scanline bytes.
    expect_error(
        &[
            &source[..33],
            &chunk(b"IDAT", &data),
            &source[source.len() - 12..],
        ]
        .concat(),
        2,
    );
}
#[test]
fn jpeg_rejects_bad_markers_early_eoi_truncation_and_tail() {
    let mut source = fixture("source.jpg");
    source[2] = 0;
    expect_error(&source, 2);
    let source = fixture("source.jpg");
    expect_error(&[&source[..source.len() - 22], b"\xff\xd9"].concat(), 2);
    expect_error(&source[..source.len() - 2], 2);
    expect_error(&[source.as_slice(), b"private-tail"].concat(), 2);
    expect_error(
        &[&source[..source.len() - 2], &[1, 2, 3, 4], b"\xff\xd9"].concat(),
        2,
    );
    for name in ["source.jpg", "progressive.jpg"] {
        let source = fixture(name);
        // The progressive fixture's final scan starts exactly 20 bytes before EOI.
        // Removing that entire scan leaves a legal lower-precision progressive image;
        // the separate test below covers that boundary. These cuts damage scan/segment data.
        let cuts: &[usize] = if name == "source.jpg" {
            &[1, 5, 10, 20, 30]
        } else {
            &[1, 5, 10, 18, 21, 30]
        };
        for &cut in cuts {
            expect_error(
                &[&source[..source.len() - cut - 2], b"\xff\xd9"].concat(),
                2,
            );
        }
    }
}
#[test]
fn complete_progressive_scans_can_end_before_optional_refinement() {
    let source = fixture("progressive.jpg");
    let boundary = source.len() - 22;
    assert_eq!(&source[boundary..boundary + 2], b"\xff\xda");
    for marker_fill in [b"".as_slice(), b"\xff"] {
        let input = [&source[..boundary], marker_fill, b"\xff\xd9"].concat();
        let output = run(&input, "32000000");
        assert_eq!(output.status.code(), Some(0));
        let (width, height, _) = decode(&output.stdout);
        assert_eq!((width, height), (2, 3));
        assert!(output.stderr.is_empty());
    }
}
fn minimal_jpeg(restart: bool, padding: u8) -> Vec<u8> {
    fn segment(marker: u8, body: &[u8]) -> Vec<u8> {
        [
            &[0xff, marker],
            &((body.len() + 2) as u16).to_be_bytes(),
            body,
        ]
        .concat()
    }
    let mut quant = vec![0];
    quant.extend_from_slice(&[1; 64]);
    let mut tables = vec![0, 1];
    tables.extend_from_slice(&[0; 15]);
    tables.push(0);
    tables.extend_from_slice(&[0x10, 1]);
    tables.extend_from_slice(&[0; 15]);
    tables.push(0);
    let width = if restart { 9 } else { 1 };
    let mut image = [
        b"\xff\xd8".as_slice(),
        &segment(0xdb, &quant),
        &segment(0xc0, &[8, 0, 1, 0, width, 1, 1, 0x11, 0]),
        &segment(0xc4, &tables),
    ]
    .concat();
    if restart {
        image.extend_from_slice(&segment(0xdd, &[0, 1]));
    }
    image.extend_from_slice(&segment(0xda, &[1, 1, 0, 0, 63, 0]));
    image.push(padding);
    if restart {
        image.extend_from_slice(&[0xff, 0xd0, 0x3f]);
    }
    image.extend_from_slice(b"\xff\xd9");
    image
}
#[test]
fn jpeg_entropy_requires_real_bits_and_legal_scan_restart_padding() {
    for restart in [false, true] {
        let output = run(&minimal_jpeg(restart, 0x3f), "32000000");
        assert_eq!(
            output.status.code(),
            Some(0),
            "restart={restart}; stderr={:?}",
            output.stderr
        );
        expect_error(&minimal_jpeg(restart, 0x3e), 2);
    }
}
#[test]
fn webp_rejects_animation_riff_mismatch_and_truncation() {
    let source = fixture("source.webp");
    let mut animated = exif_image(&source, "webp", 1);
    animated[20] |= 2;
    expect_error(&animated, 3);
    let mut wrong = source.clone();
    wrong[4] ^= 1;
    expect_error(&wrong, 2);
    expect_error(&source[..source.len() - 3], 2);
    let mut tagged = [&source[..12], &webp_chunk(b"ANMF", &[0; 16]), &source[12..]].concat();
    let size = (tagged.len() - 8) as u32;
    tagged[4..8].copy_from_slice(&size.to_le_bytes());
    expect_error(&tagged, 3);
    for name in ["source.webp", "lossy.webp"] {
        let source = fixture(name);
        let size = u32::from_le_bytes(source[16..20].try_into().unwrap()) as usize;
        let mut damaged = [
            b"RIFF\0\0\0\0WEBP".as_slice(),
            &webp_chunk(
                source[12..16].try_into().unwrap(),
                &source[20..20 + size - 10],
            ),
        ]
        .concat();
        let length = (damaged.len() - 8) as u32;
        damaged[4..8].copy_from_slice(&length.to_le_bytes());
        expect_error(&damaged, 2);
    }
}
#[test]
fn bounded_exif_rejects_invalid_orientation_and_offsets() {
    for format in ["png", "jpg", "webp"] {
        let source = fixture(&format!("source.{format}"));
        expect_error(&exif_image(&source, format, 0), 2);
        expect_error(&exif_image(&source, format, 9), 2);
    }
    let source = fixture("source.png");
    let mut exif = tiff(6);
    exif[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    expect_error(
        &[&source[..33], &chunk(b"eXIf", &exif), &source[33..]].concat(),
        2,
    );
}
#[test]
fn bytes_pixels_and_argv_are_bounded() {
    let source = fixture("source.png");
    let output = run(&source, "5");
    assert_eq!(output.status.code(), Some(4));
    assert!(output.stdout.is_empty());
    for arg in ["0", "32000001"] {
        assert_eq!(run(&source, arg).status.code(), Some(4));
    }
    for arg in ["-1", "1e6", "/tmp/file", "http://host", "1 2", ""] {
        assert_eq!(run(&source, arg).status.code(), Some(2));
    }
    expect_error(&vec![0; MAX_BYTES + 1], 4);
    expect_error(b"file:///etc/passwd", 3);
    assert_eq!(Error::Capacity.code(), 4);
}

#[test]
fn independent_png_webp_and_444_jpeg_direction_references() {
    for format in ["png", "webp", "444-jpeg"] {
        for direction in 1..=8 {
            let name = if format == "444-jpeg" {
                format!("color/444-{direction}.jpg")
            } else {
                format!("golden/{format}/{direction}.{format}")
            };
            let output = run(&fixture(&name), "32000000");
            assert_eq!(output.status.code(), Some(0), "{name}");
            let (w, h, pixels) = decode(&output.stdout);
            assert_eq!((w, h), if direction >= 5 { (2, 3) } else { (3, 2) });
            let expected = fixture(&format!("{name}.rgba"));
            assert_eq!(pixels.len(), expected.len());
            let maximum = pixels
                .iter()
                .zip(expected)
                .map(|(a, b)| a.abs_diff(b))
                .max()
                .unwrap();
            // Independent sharp decode and ICC normalization can each round by one.
            assert!(
                maximum <= if format == "444-jpeg" { 2 } else { 1 },
                "{name}: {maximum}"
            );
            assert!(output.stderr.is_empty());
        }
    }
}

#[test]
fn icc_is_transformed_to_srgb_before_metadata_removal() {
    for (name, tolerance) in [
        ("p3.png", 2),
        ("p3.jpg", 2),
        ("p3.webp", 2),
        ("p3-alpha.png", 2),
        ("grayscale.jpg", 0),
        ("cmyk-profile.jpg", 21),
    ] {
        let input = fixture(&format!("color/{name}"));
        let output = run(&input, "32000000");
        assert_eq!(output.status.code(), Some(0), "{name}: {:?}", output.stderr);
        let (w, h, pixels) = decode(&output.stdout);
        assert_eq!((w, h), (3, 2));
        let expected = fixture(&format!("color/{name}.rgba"));
        assert_eq!(pixels.len(), expected.len());
        let max = pixels
            .iter()
            .zip(&expected)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(max <= tolerance, "{name}: {max}");
        for (actual, reference) in pixels.chunks_exact(4).zip(expected.chunks_exact(4)) {
            assert_eq!(actual[3], reference[3], "alpha {name}");
        }
        let mut at = 8;
        while at < output.stdout.len() {
            assert!(matches!(
                &output.stdout[at + 4..at + 8],
                b"IHDR" | b"IDAT" | b"IEND"
            ));
            at += 12 + u32::from_be_bytes(output.stdout[at..at + 4].try_into().unwrap()) as usize;
        }
    }
}

#[test]
fn cmyk_components_match_independent_decoder_and_keep_primary_structure() {
    for name in ["cmyk.jpg", "cmyk-profile.jpg"] {
        let input = fixture(&format!("color/{name}"));
        let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(&input));
        assert_eq!(
            decoder.decode().unwrap(),
            fixture(&format!("color/{name}.cmyk"))
        );
        let output = run(&input, "32000000");
        assert_eq!(output.status.code(), Some(0));
        let (_, _, p) = decode(&output.stdout);
        // Six source test patches: red, green, blue, yellow, magenta, cyan.
        assert!(p[0] > p[1] && p[0] > p[2]);
        // This print profile maps saturated green toward yellow even in LCMS;
        // red/green both remain above blue, as in the independent reference.
        assert!(p[5] > p[6] && p[4] > p[6]);
        assert!(p[10] > p[8] && p[10] > p[9]);
        assert!(p[12] > p[14] && p[13] > p[14]);
        assert!(p[16] > p[17] && p[18] > p[17]);
        assert!(p[21] > p[20] && p[22] > p[20]);
    }
}

#[test]
fn icc_inflate_profiles_and_jpeg_fragments_are_bounded_and_strict() {
    let source = fixture("source.png");
    for (profile, code) in [(vec![0; 132], 2), (vec![0; 4 * 1024 * 1024 + 1], 4)] {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(&profile).unwrap();
        let body = [b"profile\0\0".as_slice(), &z.finish().unwrap()].concat();
        expect_error(
            &[&source[..33], &chunk(b"iCCP", &body), &source[33..]].concat(),
            code,
        );
    }
    let jpg = fixture("source.jpg");
    // Declares two ICC chunks but provides only chunk one.
    let body = b"ICC_PROFILE\0\x01\x02incomplete";
    expect_error(
        &[
            &jpg[..2],
            b"\xff\xe2",
            &((body.len() + 2) as u16).to_be_bytes(),
            body,
            &jpg[2..],
        ]
        .concat(),
        2,
    );
}
