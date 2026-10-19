use crate::{Error, Result};

// Read only TIFF IFD0. Never follow thumbnail, GPS, maker-note, file, or URI references.
pub fn orientation(mut bytes: &[u8]) -> Result<u8> {
    if bytes.starts_with(b"Exif\0\0") {
        bytes = &bytes[6..];
    }
    if bytes.len() < 8 {
        return Err(Error::Invalid);
    }
    let le = match &bytes[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return Err(Error::Invalid),
    };
    let u16_at = |offset: usize| -> Result<u16> {
        let b: [u8; 2] = bytes
            .get(offset..offset.checked_add(2).ok_or(Error::Invalid)?)
            .ok_or(Error::Invalid)?
            .try_into()
            .map_err(|_| Error::Invalid)?;
        Ok(if le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let u32_at = |offset: usize| -> Result<u32> {
        let b: [u8; 4] = bytes
            .get(offset..offset.checked_add(4).ok_or(Error::Invalid)?)
            .ok_or(Error::Invalid)?
            .try_into()
            .map_err(|_| Error::Invalid)?;
        Ok(if le {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    };
    if u16_at(2)? != 42 {
        return Err(Error::Invalid);
    }
    let offset = u32_at(4)? as usize;
    if offset < 8 {
        return Err(Error::Invalid);
    }
    let count = u16_at(offset)? as usize;
    let end = offset
        .checked_add(2 + count * 12 + 4)
        .ok_or(Error::Invalid)?;
    if end > bytes.len() {
        return Err(Error::Invalid);
    }
    let mut value = None;
    for i in 0..count {
        let at = offset + 2 + i * 12;
        let tag = u16_at(at)?;
        let field_type = u16_at(at + 2)?;
        let size = match field_type {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 | 13 => 4,
            5 | 10 | 12 => 8,
            _ => return Err(Error::Invalid),
        };
        let count = u32_at(at + 4)? as usize;
        let length = count.checked_mul(size).ok_or(Error::Invalid)?;
        if length > 4 {
            let data_at = u32_at(at + 8)? as usize;
            if data_at < 8 || data_at.checked_add(length).ok_or(Error::Invalid)? > bytes.len() {
                return Err(Error::Invalid);
            }
        }
        if tag == 0x112 {
            if value.is_some() || field_type != 3 || count != 1 {
                return Err(Error::Invalid);
            }
            let direction = u16_at(at + 8)?;
            if !(1..=8).contains(&direction) {
                return Err(Error::Invalid);
            }
            value = Some(direction as u8);
        }
    }
    let next = u32_at(end - 4)? as usize;
    if next != 0 && (next < 8 || next + 2 > bytes.len()) {
        return Err(Error::Invalid);
    }
    Ok(value.unwrap_or(1))
}
