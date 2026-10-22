use crate::{Error, Result};
use moxcms::{
    ColorProfile, DataColorSpace, InterpolationMethod, Layout, ParsingOptions, TransformOptions,
};

pub const MAX_ICC_BYTES: usize = 4 * 1024 * 1024;

pub fn profile(bytes: &[u8]) -> Result<ColorProfile> {
    if bytes.len() > MAX_ICC_BYTES {
        return Err(Error::Capacity);
    }
    if bytes.len() < 132 || &bytes[36..40] != b"acsp" {
        return Err(Error::Invalid);
    }
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    if word(0) != bytes.len() {
        return Err(Error::Invalid);
    }
    let count = word(128);
    if count > 1024 {
        return Err(Error::Capacity);
    }
    let end = 132 + count * 12;
    if end > bytes.len() {
        return Err(Error::Invalid);
    }
    for at in (132..end).step_by(12) {
        let offset = word(at + 4);
        let size = word(at + 8);
        if offset < end || size < 8 || offset.checked_add(size).ok_or(Error::Invalid)? > bytes.len()
        {
            return Err(Error::Invalid);
        }
    }
    ColorProfile::new_from_slice_with_options(
        bytes,
        ParsingOptions {
            max_profile_size: MAX_ICC_BYTES + 1,
            max_allowed_clut_size: MAX_ICC_BYTES,
            max_allowed_trc_size: 40_000,
        },
    )
    .map_err(|_| Error::Invalid)
}

fn options() -> TransformOptions {
    TransformOptions {
        interpolation_method: InterpolationMethod::Tetrahedral,
        prefer_fixed_point: false,
        ..TransformOptions::default()
    }
}

pub fn rgba(rgba: Vec<u8>, icc: Option<&[u8]>) -> Result<Vec<u8>> {
    let Some(icc) = icc else {
        return Ok(rgba);
    };
    let source = profile(icc)?;
    let destination = ColorProfile::new_srgb();
    let (input, layout) = match source.color_space {
        DataColorSpace::Rgb => (rgba.as_slice(), Layout::Rgba),
        DataColorSpace::Gray => {
            // The codecs expanded grayscale. Transform its actual gray samples,
            // while keeping the original alpha separately.
            let gray: Vec<u8> = rgba.chunks_exact(4).map(|p| p[0]).collect();
            let transform = source
                .create_transform_8bit(Layout::Gray, &destination, Layout::Rgba, options())
                .map_err(|_| Error::Invalid)?;
            let mut output = vec![0; rgba.len()];
            transform
                .transform(&gray, &mut output)
                .map_err(|_| Error::Invalid)?;
            for (from, to) in rgba.chunks_exact(4).zip(output.chunks_exact_mut(4)) {
                to[3] = from[3];
            }
            return Ok(output);
        }
        _ => return Err(Error::Invalid),
    };
    let transform = source
        .create_transform_8bit(layout, &destination, Layout::Rgba, options())
        .map_err(|_| Error::Invalid)?;
    let mut output = vec![0; rgba.len()];
    transform
        .transform(input, &mut output)
        .map_err(|_| Error::Invalid)?;
    for (from, to) in rgba.chunks_exact(4).zip(output.chunks_exact_mut(4)) {
        to[3] = from[3];
    }
    Ok(output)
}

pub fn cmyk(bytes: &[u8], icc: &[u8]) -> Result<Vec<u8>> {
    let source = profile(icc)?;
    if source.color_space != DataColorSpace::Cmyk {
        return Err(Error::Invalid);
    }
    let destination = ColorProfile::new_srgb();
    // CMYK uses four source components, not RGBA alpha. A three-component
    // destination ensures K cannot be accidentally copied to output alpha.
    let transform = source
        .create_transform_8bit(Layout::Rgba, &destination, Layout::Rgb, options())
        .map_err(|_| Error::Invalid)?;
    let mut rgb = vec![0; bytes.len() / 4 * 3];
    transform
        .transform(bytes, &mut rgb)
        .map_err(|_| Error::Invalid)?;
    let mut rgba = Vec::with_capacity(bytes.len());
    for p in rgb.chunks_exact(3) {
        rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
    }
    Ok(rgba)
}

pub fn inflate_icc(body: &[u8]) -> Result<Vec<u8>> {
    let name_end = body.iter().position(|b| *b == 0).ok_or(Error::Invalid)?;
    if !(1..=79).contains(&name_end) || body.get(name_end + 1) != Some(&0) {
        return Err(Error::Invalid);
    }
    let input = body.get(name_end + 2..).ok_or(Error::Invalid)?;
    let mut decoder = flate2::Decompress::new(true);
    let mut scratch = [0_u8; 64 * 1024];
    let mut output = Vec::new();
    loop {
        let before = (decoder.total_in(), decoder.total_out());
        let status = decoder
            .decompress(
                &input[before.0 as usize..],
                &mut scratch,
                flate2::FlushDecompress::None,
            )
            .map_err(|_| Error::Invalid)?;
        let added = (decoder.total_out() - before.1) as usize;
        if output.len() + added > MAX_ICC_BYTES {
            return Err(Error::Capacity);
        }
        output.extend_from_slice(&scratch[..added]);
        if status == flate2::Status::StreamEnd {
            return if decoder.total_in() == input.len() as u64 {
                Ok(output)
            } else {
                Err(Error::Invalid)
            };
        }
        if before == (decoder.total_in(), decoder.total_out()) {
            return Err(Error::Invalid);
        }
    }
}

pub fn jpeg_icc(parts: &[(u8, u8, Vec<u8>)]) -> Result<Option<Vec<u8>>> {
    if parts.is_empty() {
        return Ok(None);
    }
    let total = usize::from(parts[0].1);
    if total == 0 || total != parts.len() {
        return Err(Error::Invalid);
    }
    let mut output = Vec::new();
    for sequence in 1..=total {
        let mut found = parts.iter().filter(|p| usize::from(p.0) == sequence);
        let part = found.next().ok_or(Error::Invalid)?;
        if usize::from(part.1) != total || found.next().is_some() {
            return Err(Error::Invalid);
        }
        if output.len() + part.2.len() > MAX_ICC_BYTES {
            return Err(Error::Capacity);
        }
        output.extend_from_slice(&part.2);
    }
    Ok(Some(output))
}
