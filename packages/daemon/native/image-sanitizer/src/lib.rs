mod color;
mod container;
mod exif;
use std::io::{Cursor, Write};

pub const MAX_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 32_000_000;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Unsupported,
    Capacity,
}
impl Error {
    pub fn code(self) -> i32 {
        match self {
            Self::Invalid => 2,
            Self::Unsupported => 3,
            Self::Capacity => 4,
        }
    }
}

pub fn sanitize(input: &[u8], max_pixels: u64) -> Result<Vec<u8>> {
    if input.len() > MAX_BYTES || !(1..=MAX_PIXELS).contains(&max_pixels) {
        return Err(Error::Capacity);
    }
    let preflight = container::inspect(input, max_pixels)?;
    let pixels = match preflight.kind {
        container::Kind::Png => decode_png(input, &preflight)?,
        container::Kind::Jpeg => decode_jpeg(input, &preflight)?,
        container::Kind::Webp => decode_webp(input, &preflight)?,
    };
    let (width, height, pixels) = orient(
        pixels,
        preflight.width,
        preflight.height,
        preflight.orientation,
    )?;
    encode_png(width, height, &pixels, MAX_BYTES)
}

fn decode_png(input: &[u8], p: &container::Preflight) -> Result<Vec<u8>> {
    // png's decoder intentionally tolerates trailing/missing zlib data in some cases.
    // Independently require the exact Adam7/noninterlaced scanline byte count and stream end.
    validate_png_zlib(input, p)?;
    let mut options = png::DecodeOptions::default();
    options.set_ignore_crc(false);
    options.set_ignore_adler32(false);
    options.set_skip_ancillary_crc_failures(false);
    options.set_ignore_text_chunk(true);
    options.set_ignore_iccp_chunk(true);
    let mut decoder = png::Decoder::new_with_options(Cursor::new(input), options);
    decoder.set_limits(png::Limits {
        bytes: 256 * 1024 * 1024,
    });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(png_error)?;
    if reader.info().animation_control.is_some() {
        return Err(Error::Unsupported);
    }
    if (reader.info().width, reader.info().height) != (p.width, p.height) {
        return Err(Error::Invalid);
    }
    let length = reader.output_buffer_size().ok_or(Error::Capacity)?;
    if length > 4 * p.width as usize * p.height as usize {
        return Err(Error::Capacity);
    }
    let mut decoded = vec![0; length];
    let frame = reader.next_frame(&mut decoded).map_err(png_error)?;
    reader.finish().map_err(png_error)?;
    if frame.bit_depth != png::BitDepth::Eight || (frame.width, frame.height) != (p.width, p.height)
    {
        return Err(Error::Invalid);
    }
    decoded.truncate(frame.buffer_size());
    let channels = frame.color_type.samples();
    let mut rgba = Vec::with_capacity(p.width as usize * p.height as usize * 4);
    for pixel in decoded.chunks_exact(channels) {
        match frame.color_type {
            png::ColorType::Rgba => rgba.extend_from_slice(pixel),
            png::ColorType::Rgb => rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]),
            png::ColorType::Grayscale => {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], 255])
            }
            png::ColorType::GrayscaleAlpha => {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]])
            }
            _ => return Err(Error::Invalid),
        }
    }
    color::rgba(check_rgba(rgba, p)?, p.icc.as_deref())
}
fn validate_png_zlib(input: &[u8], p: &container::Preflight) -> Result<()> {
    let depth = u64::from(input[24]);
    let samples = match input[25] {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => return Err(Error::Invalid),
    };
    if !matches!(depth, 1 | 2 | 4 | 8 | 16) {
        return Err(Error::Invalid);
    }
    let pass_bytes = |x: u32, y: u32, dx: u32, dy: u32| -> u64 {
        if p.width <= x || p.height <= y {
            return 0;
        }
        let w = u64::from((p.width - x).div_ceil(dx));
        let h = u64::from((p.height - y).div_ceil(dy));
        ((w * depth * samples).div_ceil(8) + 1) * h
    };
    let expected = match input[28] {
        0 => pass_bytes(0, 0, 1, 1),
        1 => [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
        .into_iter()
        .map(|(x, y, dx, dy)| pass_bytes(x, y, dx, dy))
        .sum(),
        _ => return Err(Error::Invalid),
    };
    let mut compressed = Vec::new();
    let mut at = 8;
    while at + 12 <= input.len() {
        let size =
            u32::from_be_bytes(input[at..at + 4].try_into().map_err(|_| Error::Invalid)?) as usize;
        if &input[at + 4..at + 8] == b"IDAT" {
            compressed.extend_from_slice(&input[at + 8..at + 8 + size]);
        }
        at += size + 12;
    }
    let mut decoder = flate2::Decompress::new(true);
    let mut scratch = [0_u8; 64 * 1024];
    loop {
        let before = (decoder.total_in(), decoder.total_out());
        let status = decoder
            .decompress(
                &compressed[before.0 as usize..],
                &mut scratch,
                flate2::FlushDecompress::None,
            )
            .map_err(|_| Error::Invalid)?;
        if decoder.total_out() > expected {
            return Err(Error::Invalid);
        }
        if status == flate2::Status::StreamEnd {
            return if decoder.total_out() == expected
                && decoder.total_in() == compressed.len() as u64
            {
                Ok(())
            } else {
                Err(Error::Invalid)
            };
        }
        if before == (decoder.total_in(), decoder.total_out()) {
            return Err(Error::Invalid);
        }
    }
}
fn png_error(e: png::DecodingError) -> Error {
    match e {
        png::DecodingError::LimitsExceeded => Error::Capacity,
        _ => Error::Invalid,
    }
}

fn decode_jpeg(input: &[u8], p: &container::Preflight) -> Result<Vec<u8>> {
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(input));
    decoder.set_max_decoding_buffer_size(256 * 1024 * 1024);
    decoder.read_info().map_err(|_| Error::Invalid)?;
    let info = decoder.info().ok_or(Error::Invalid)?;
    if (u32::from(info.width), u32::from(info.height)) != (p.width, p.height) {
        return Err(Error::Invalid);
    }
    let bytes = decoder.decode().map_err(|_| Error::Invalid)?;
    let pixels = p.width as usize * p.height as usize;
    if bytes.len() != pixels * info.pixel_format.pixel_bytes() {
        return Err(Error::Invalid);
    }
    let mut rgba = Vec::with_capacity(pixels * 4);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => {
            for y in bytes {
                rgba.extend_from_slice(&[y, y, y, 255]);
            }
        }
        jpeg_decoder::PixelFormat::RGB24 => {
            for rgb in bytes.chunks_exact(3) {
                rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        jpeg_decoder::PixelFormat::CMYK32 => {
            if let Some(icc) = p.icc.as_deref() {
                return check_rgba(color::cmyk(&bytes, icc)?, p);
            }
            for cmyk in bytes.chunks_exact(4) {
                let k = 255 - u16::from(cmyk[3]);
                rgba.extend_from_slice(&[
                    ((255 - u16::from(cmyk[0])) * k / 255) as u8,
                    ((255 - u16::from(cmyk[1])) * k / 255) as u8,
                    ((255 - u16::from(cmyk[2])) * k / 255) as u8,
                    255,
                ]);
            }
        }
        _ => return Err(Error::Unsupported),
    }
    color::rgba(check_rgba(rgba, p)?, p.icc.as_deref())
}

fn decode_webp(input: &[u8], p: &container::Preflight) -> Result<Vec<u8>> {
    let mut decoder =
        image_webp::WebPDecoder::new(Cursor::new(input)).map_err(|_| Error::Invalid)?;
    // The codec documents incomplete enforcement. The process-wide allocation budget is authoritative.
    decoder.set_memory_limit(128 * 1024 * 1024);
    if decoder.is_animated() {
        return Err(Error::Unsupported);
    }
    if decoder.dimensions() != (p.width, p.height) {
        return Err(Error::Invalid);
    }
    let length = decoder.output_buffer_size().ok_or(Error::Capacity)?;
    let pixels = p.width as usize * p.height as usize;
    if length != pixels * if decoder.has_alpha() { 4 } else { 3 } {
        return Err(Error::Invalid);
    }
    let mut decoded = vec![0; length];
    decoder
        .read_image(&mut decoded)
        .map_err(|_| Error::Invalid)?;
    if decoder.has_alpha() {
        return color::rgba(check_rgba(decoded, p)?, p.icc.as_deref());
    }
    let mut rgba = Vec::with_capacity(pixels * 4);
    for rgb in decoded.chunks_exact(3) {
        rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
    }
    color::rgba(check_rgba(rgba, p)?, p.icc.as_deref())
}

fn check_rgba(bytes: Vec<u8>, p: &container::Preflight) -> Result<Vec<u8>> {
    if bytes.len() != p.width as usize * p.height as usize * 4 {
        return Err(Error::Invalid);
    }
    Ok(bytes)
}

fn orient(bytes: Vec<u8>, width: u32, height: u32, direction: u8) -> Result<(u32, u32, Vec<u8>)> {
    if direction == 1 {
        return Ok((width, height, bytes));
    }
    let (w, h) = (width as usize, height as usize);
    let (out_w, out_h) = if direction >= 5 { (h, w) } else { (w, h) };
    let mut output = vec![0; bytes.len()];
    for y in 0..h {
        for x in 0..w {
            let (ox, oy) = match direction {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (h - 1 - y, x),
                7 => (h - 1 - y, w - 1 - x),
                8 => (y, w - 1 - x),
                _ => return Err(Error::Invalid),
            };
            output[(oy * out_w + ox) * 4..(oy * out_w + ox + 1) * 4]
                .copy_from_slice(&bytes[(y * w + x) * 4..(y * w + x + 1) * 4]);
        }
    }
    Ok((out_w as u32, out_h as u32, output))
}

struct BoundedOutput {
    bytes: Vec<u8>,
    max: usize,
    exceeded: bool,
}
impl Write for BoundedOutput {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if b.len() > self.max.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("capacity_exceeded"));
        }
        self.bytes.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode_png(width: u32, height: u32, pixels: &[u8], max: usize) -> Result<Vec<u8>> {
    let mut output = BoundedOutput {
        bytes: Vec::new(),
        max,
        exceeded: false,
    };
    let result = (|| {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(pixels)?;
        writer.finish()
    })();
    if output.exceeded {
        return Err(Error::Capacity);
    }
    result.map_err(|_| Error::Invalid)?;
    Ok(output.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_limit_is_applied_before_publication() {
        assert_eq!(encode_png(1, 1, &[1, 2, 3, 4], 8), Err(Error::Capacity));
    }
}
