use crate::{Error, Result, color, exif};

#[derive(Clone, Copy)]
pub enum Kind {
    Png,
    Jpeg,
    Webp,
}
pub struct Preflight {
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
    pub icc: Option<Vec<u8>>,
}

pub fn inspect(bytes: &[u8], max_pixels: u64) -> Result<Preflight> {
    let image = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes)?
    } else if bytes.starts_with(b"\xff\xd8") {
        jpeg(bytes)?
    } else if bytes.starts_with(b"RIFF") {
        webp(bytes)?
    } else {
        return Err(Error::Unsupported);
    };
    if image.width == 0 || image.height == 0 {
        return Err(Error::Invalid);
    }
    if u64::from(image.width) * u64::from(image.height) > max_pixels {
        return Err(Error::Capacity);
    }
    Ok(image)
}
fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}
fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}
fn le24(b: &[u8]) -> u32 {
    u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16
}

fn png(bytes: &[u8]) -> Result<Preflight> {
    let mut at = 8;
    let (mut width, mut height) = (0, 0);
    let mut seen_header = false;
    let mut seen_data = false;
    let mut data_ended = false;
    let mut direction = None;
    let mut icc = None;
    while at + 12 <= bytes.len() {
        let size = be32(&bytes[at..at + 4]) as usize;
        let end = at
            .checked_add(12)
            .and_then(|v| v.checked_add(size))
            .ok_or(Error::Invalid)?;
        if end > bytes.len() {
            return Err(Error::Invalid);
        }
        let kind = &bytes[at + 4..at + 8];
        if !kind.iter().all(u8::is_ascii_alphabetic) || kind[2] & 0x20 != 0 {
            return Err(Error::Invalid);
        }
        if crc32fast::hash(&bytes[at + 4..end - 4]) != be32(&bytes[end - 4..end]) {
            return Err(Error::Invalid);
        }
        let body = &bytes[at + 8..end - 4];
        if !seen_header && kind != b"IHDR" {
            return Err(Error::Invalid);
        }
        if seen_data && kind != b"IDAT" {
            data_ended = true;
        }
        match kind {
            b"IHDR" => {
                if seen_header || at != 8 || size != 13 {
                    return Err(Error::Invalid);
                }
                width = be32(&body[..4]);
                height = be32(&body[4..8]);
                seen_header = true;
            }
            b"IDAT" => {
                if data_ended {
                    return Err(Error::Invalid);
                }
                seen_data = true;
            }
            b"IEND" => {
                if size != 0 || !seen_data || end != bytes.len() {
                    return Err(Error::Invalid);
                }
                return Ok(Preflight {
                    kind: Kind::Png,
                    width,
                    height,
                    orientation: direction.unwrap_or(1),
                    icc,
                });
            }
            b"acTL" | b"fcTL" | b"fdAT" => return Err(Error::Unsupported),
            b"iCCP" => {
                if icc.is_some() || seen_data {
                    return Err(Error::Invalid);
                }
                icc = Some(color::inflate_icc(body)?);
            }
            b"eXIf" => {
                if direction.is_some() {
                    return Err(Error::Invalid);
                }
                direction = Some(exif::orientation(body)?);
            }
            b"PLTE" => {
                if seen_data {
                    return Err(Error::Invalid);
                }
            }
            _ if kind[0] & 0x20 == 0 => return Err(Error::Unsupported),
            _ => {}
        }
        at = end;
    }
    Err(Error::Invalid)
}

fn jpeg(bytes: &[u8]) -> Result<Preflight> {
    let mut at = 2;
    let (mut width, mut height) = (0, 0);
    let mut frame = None;
    let mut components = Vec::new();
    let mut scans = 0;
    let mut restart_interval = 0;
    let mut direction = None;
    let mut icc_parts = Vec::new();
    let mut icc_bytes = 0;
    while at < bytes.len() {
        if bytes[at] != 0xff {
            return Err(Error::Invalid);
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at).ok_or(Error::Invalid)?;
        at += 1;
        if marker == 0xd9 {
            if scans == 0 || frame.is_none() || at != bytes.len() {
                return Err(Error::Invalid);
            }
            return Ok(Preflight {
                kind: Kind::Jpeg,
                width,
                height,
                orientation: direction.unwrap_or(1),
                icc: color::jpeg_icc(&icc_parts)?,
            });
        }
        if matches!(marker, 0x00 | 0xd0..=0xd8 | 0x01 | 0xff) || at + 2 > bytes.len() {
            return Err(Error::Invalid);
        }
        let length = be16(&bytes[at..at + 2]) as usize;
        if length < 2 || at + length > bytes.len() {
            return Err(Error::Invalid);
        }
        let body = &bytes[at + 2..at + length];
        at += length;
        match marker {
            0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => {
                if !matches!(marker, 0xc0..=0xc2) {
                    return Err(Error::Unsupported);
                }
                if frame.is_some() || body.len() < 6 || body[0] != 8 {
                    return Err(Error::Invalid);
                }
                let count = body[5] as usize;
                if !(1..=4).contains(&count) || body.len() != 6 + count * 3 {
                    return Err(Error::Invalid);
                }
                height = u32::from(be16(&body[1..3]));
                width = u32::from(be16(&body[3..5]));
                for entry in body[6..].chunks_exact(3) {
                    if components.contains(&entry[0])
                        || entry[1] >> 4 == 0
                        || entry[1] & 15 == 0
                        || entry[1] >> 4 > 4
                        || entry[1] & 15 > 4
                        || entry[2] > 3
                    {
                        return Err(Error::Invalid);
                    }
                    components.push(entry[0]);
                }
                frame = Some(marker);
            }
            0xe1 if body.starts_with(b"Exif\0\0") => {
                if direction.is_some() {
                    return Err(Error::Invalid);
                }
                direction = Some(exif::orientation(body)?);
            }
            0xe2 if body.starts_with(b"ICC_PROFILE\0") => {
                if body.len() < 14 {
                    return Err(Error::Invalid);
                }
                icc_bytes += body.len() - 14;
                if icc_bytes > color::MAX_ICC_BYTES {
                    return Err(Error::Capacity);
                }
                if icc_parts.len() >= 255 {
                    return Err(Error::Invalid);
                }
                icc_parts.push((body[12], body[13], body[14..].to_vec()));
            }
            0xdd => {
                if body.len() != 2 {
                    return Err(Error::Invalid);
                }
                restart_interval = be16(body);
            }
            0xda => {
                let mode = frame.ok_or(Error::Invalid)?;
                if body.len() < 4 {
                    return Err(Error::Invalid);
                }
                let count = body[0] as usize;
                if count == 0 || count > components.len() || body.len() != 4 + count * 2 {
                    return Err(Error::Invalid);
                }
                let mut seen = Vec::new();
                for entry in body[1..1 + count * 2].chunks_exact(2) {
                    if !components.contains(&entry[0])
                        || seen.contains(&entry[0])
                        || entry[1] >> 4 > 3
                        || entry[1] & 15 > 3
                    {
                        return Err(Error::Invalid);
                    }
                    seen.push(entry[0]);
                }
                if mode != 0xc2 && body[body.len() - 3..] != [0, 63, 0] {
                    return Err(Error::Invalid);
                }
                scans += 1;
                if scans > 256 {
                    return Err(Error::Capacity);
                }
                let start = at;
                let mut restart = 0;
                loop {
                    let value = *bytes.get(at).ok_or(Error::Invalid)?;
                    if value != 0xff {
                        at += 1;
                        continue;
                    }
                    let marker_at = at;
                    at += 1;
                    while bytes.get(at) == Some(&0xff) {
                        at += 1;
                    }
                    match *bytes.get(at).ok_or(Error::Invalid)? {
                        0x00 => {
                            at += 1;
                        }
                        m @ 0xd0..=0xd7 => {
                            if restart_interval == 0 || m != 0xd0 + restart {
                                return Err(Error::Invalid);
                            }
                            restart = (restart + 1) % 8;
                            at += 1;
                        }
                        _ => {
                            at = marker_at;
                            break;
                        }
                    }
                }
                if at == start {
                    return Err(Error::Invalid);
                }
            }
            0xc4 | 0xdb | 0xfe | 0xe0..=0xef => {}
            _ => return Err(Error::Unsupported),
        }
    }
    Err(Error::Invalid)
}

fn webp(bytes: &[u8]) -> Result<Preflight> {
    if bytes.len() < 20
        || &bytes[8..12] != b"WEBP"
        || le32(&bytes[4..8]) as usize + 8 != bytes.len()
    {
        return Err(Error::Invalid);
    }
    let mut at = 12;
    let mut extended = None;
    let mut image = None;
    let mut alpha = false;
    let mut direction = None;
    let mut icc: Option<Vec<u8>> = None;
    let mut xmp = false;
    let mut lossless_alpha = false;
    while at + 8 <= bytes.len() {
        let kind = &bytes[at..at + 4];
        if !kind.iter().all(|c| (0x20..=0x7e).contains(c)) {
            return Err(Error::Invalid);
        }
        let size = le32(&bytes[at + 4..at + 8]) as usize;
        let end = at
            .checked_add(8)
            .and_then(|v| v.checked_add(size))
            .ok_or(Error::Invalid)?;
        let next = end.checked_add(size % 2).ok_or(Error::Invalid)?;
        if next > bytes.len() || (size % 2 != 0 && bytes[end] != 0) {
            return Err(Error::Invalid);
        }
        let body = &bytes[at + 8..end];
        match kind {
            b"ANIM" | b"ANMF" => return Err(Error::Unsupported),
            b"VP8X" => {
                if extended.is_some()
                    || at != 12
                    || size != 10
                    || body[0] & 0xc1 != 0
                    || body[1..4] != [0, 0, 0]
                {
                    return Err(Error::Invalid);
                }
                if body[0] & 0x02 != 0 {
                    return Err(Error::Unsupported);
                }
                extended = Some((body[0], le24(&body[4..7]) + 1, le24(&body[7..10]) + 1));
            }
            b"VP8 " => {
                if image.is_some() || size < 10 || body[0] & 1 != 0 || body[3..6] != [0x9d, 1, 0x2a]
                {
                    return Err(Error::Invalid);
                }
                let w = (u16::from(body[6]) | u16::from(body[7]) << 8) & 0x3fff;
                let h = (u16::from(body[8]) | u16::from(body[9]) << 8) & 0x3fff;
                image = Some((false, u32::from(w), u32::from(h)));
            }
            b"VP8L" => {
                if image.is_some() || size < 5 || body[0] != 0x2f {
                    return Err(Error::Invalid);
                }
                let bits = le32(&body[1..5]);
                if bits >> 29 != 0 {
                    return Err(Error::Invalid);
                }
                lossless_alpha = bits & 0x1000_0000 != 0;
                image = Some((true, (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            b"ALPH" => {
                if alpha || image.is_some() || size == 0 {
                    return Err(Error::Invalid);
                }
                alpha = true;
            }
            b"EXIF" => {
                if direction.is_some() {
                    return Err(Error::Invalid);
                }
                direction = Some(exif::orientation(body)?);
            }
            b"ICCP" => {
                if icc.is_some() || image.is_some() {
                    return Err(Error::Invalid);
                }
                if body.len() > color::MAX_ICC_BYTES {
                    return Err(Error::Capacity);
                }
                icc = Some(body.to_vec());
            }
            b"XMP " => {
                if xmp {
                    return Err(Error::Invalid);
                }
                xmp = true;
            }
            _ => {}
        }
        at = next;
    }
    if at != bytes.len() {
        return Err(Error::Invalid);
    }
    let (lossless, width, height) = image.ok_or(Error::Invalid)?;
    if let Some((flags, w, h)) = extended {
        if (width, height) != (w, h)
            || (flags & 0x08 != 0) != direction.is_some()
            || (flags & 0x20 != 0) != icc.is_some()
            || (flags & 0x04 != 0) != xmp
            || (flags & 0x10 != 0) != (alpha || lossless_alpha)
            || (lossless && alpha)
        {
            return Err(Error::Invalid);
        }
    } else if alpha || direction.is_some() || icc.is_some() || xmp {
        return Err(Error::Invalid);
    }
    Ok(Preflight {
        kind: Kind::Webp,
        width,
        height,
        orientation: direction.unwrap_or(1),
        icc,
    })
}
