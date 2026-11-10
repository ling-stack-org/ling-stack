use serde::Deserialize;
use std::io::{self, Read};

pub const PROTOCOL: &str = "ling.engine-supervisor.v1";
#[cfg(windows)]
pub const ACK: &[u8] =
    b"{\"protocol\":\"ling.engine-supervisor.v1\",\"version\":\"0.1.0\",\"started\":true}\n";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub protocol: String,
    pub executable: String,
    pub digest: String,
    pub args: Vec<String>,
    pub cwd: String,
}

pub fn invalid() -> io::Error {
    io::Error::other("engine_supervisor_invalid")
}

pub fn read_launch(reader: &mut impl Read) -> io::Result<Launch> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > 65536 {
        return Err(invalid());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let launch: Launch = serde_json::from_slice(&body).map_err(|_| invalid())?;
    if launch.protocol != PROTOCOL
        || !local_path(&launch.executable)
        || !launch.executable.to_ascii_lowercase().ends_with(".exe")
        || !local_path(&launch.cwd)
        || launch.digest.len() != 64
        || !launch
            .digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || launch.args.len() > 256
        || launch.args.iter().any(|s| s.contains('\0'))
    {
        return Err(invalid());
    }
    Ok(launch)
}

fn local_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && !bytes.contains(&0)
        && !bytes[2..].contains(&b':')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::io::Cursor;

    fn request() -> Value {
        json!({"protocol":PROTOCOL,"executable":"C:\\Program Files\\Agent\\agent.exe",
            "cwd":"C:\\Users\\fixture", "digest":"a".repeat(64), "args":["quoted value", "&literal"]})
    }

    fn frame(value: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(value).unwrap();
        [(body.len() as u32).to_le_bytes().to_vec(), body].concat()
    }

    #[test]
    fn reads_exactly_one_frame_preserving_liveness_bytes() {
        let mut bytes = frame(&request());
        bytes.extend_from_slice(b"owner");
        let mut input = Cursor::new(bytes);
        let launch = read_launch(&mut input).unwrap();
        assert_eq!(launch.args, ["quoted value", "&literal"]);
        let mut remaining = String::new();
        input.read_to_string(&mut remaining).unwrap();
        assert_eq!(remaining, "owner");
    }

    #[test]
    fn rejects_truncated_oversized_and_invalid_json() {
        for bytes in [
            vec![],
            vec![1, 0],
            vec![1, 0, 0, 0],
            vec![1, 0, 0, 0, b'x'],
            65537_u32.to_le_bytes().to_vec(),
        ] {
            assert!(read_launch(&mut Cursor::new(bytes)).is_err());
        }
    }

    #[test]
    fn rejects_shims_relative_paths_unknown_fields_and_nul() {
        for (field, value) in [
            ("executable", json!("C:\\agent.cmd")),
            ("executable", json!("C:agent.exe")),
            ("executable", json!("\\\\host\\agent.exe")),
            ("cwd", json!("relative")),
            ("executable", json!("C:\\agent.exe:stream")),
            ("args", json!(["a\0b"])),
            ("digest", json!("bad")),
            ("protocol", json!("other")),
            ("shell", json!(true)),
        ] {
            let mut input = request();
            input[field] = value;
            assert!(read_launch(&mut Cursor::new(frame(&input))).is_err());
        }
    }

    #[test]
    fn rejects_duplicate_fields() {
        let body =
            serde_json::to_string(&request())
                .unwrap()
                .replacen('{', "{\"protocol\":\"other\",", 1);
        let bytes = [
            (body.len() as u32).to_le_bytes().to_vec(),
            body.into_bytes(),
        ]
        .concat();
        assert!(read_launch(&mut Cursor::new(bytes)).is_err());
    }
}
