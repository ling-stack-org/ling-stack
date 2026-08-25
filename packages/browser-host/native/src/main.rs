use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const HOST_VERSION: &str = "0.1.1";
const NATIVE_PROTOCOL: &str = "ling.chrome.native.v1";
const DESCRIPTOR_SCHEMA: &str = "ling.browser-host.runtime.v1";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const PRODUCTION_ORIGIN: &str = "chrome-extension://mbmlnnfhebclljonhedpjghbhibfapei/";
const DEVELOPMENT_ORIGIN: &str = "chrome-extension://ggmhibjboaedlnidbemkefonahjgcapc/";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeDescriptor {
    schema: String,
    protocol: String,
    host_version: String,
    port: u16,
    token: String,
    generation: String,
    daemon_pid: u32,
    expires_at_epoch_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExtensionHello {
    protocol: String,
    #[serde(rename = "type")]
    message_type: String,
    extension_version: String,
    browser_version: Option<String>,
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrokerHello<'a> {
    protocol: &'a str,
    #[serde(rename = "type")]
    message_type: &'a str,
    extension_version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_version: Option<&'a str>,
    paused: bool,
    token: &'a str,
    origin: &'a str,
    host_version: &'a str,
}

#[derive(Serialize)]
struct HostError<'a> {
    protocol: &'a str,
    #[serde(rename = "type")]
    message_type: &'a str,
    code: &'a str,
}

fn main() {
    if let Err(code) = run() {
        let _ = write_json_frame(&mut io::stdout().lock(), &HostError {
            protocol: NATIVE_PROTOCOL,
            message_type: "error",
            code,
        });
        eprintln!("Ling Browser Host stopped: {code}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let origin = env::args().nth(1).ok_or("origin_forbidden")?;
    if origin != PRODUCTION_ORIGIN && origin != DEVELOPMENT_ORIGIN {
        return Err("origin_forbidden");
    }
    let descriptor = read_descriptor().map_err(|_| "descriptor_invalid")?;
    if descriptor.schema != DESCRIPTOR_SCHEMA
        || descriptor.protocol != NATIVE_PROTOCOL
        || descriptor.host_version != HOST_VERSION
        || descriptor.token.is_empty()
        || descriptor.generation.is_empty()
        || descriptor.daemon_pid == 0
        || descriptor.expires_at_epoch_ms <= now_epoch_ms()
    {
        return Err("descriptor_invalid");
    }
    let first = read_frame(&mut io::stdin().lock()).map_err(|_| "native_protocol_invalid")?
        .ok_or("native_protocol_invalid")?;
    let hello: ExtensionHello = serde_json::from_slice(&first).map_err(|_| "native_protocol_invalid")?;
    if hello.protocol != NATIVE_PROTOCOL
        || hello.message_type != "hello"
        || !compatible_version(&hello.extension_version)
    {
        return Err("version_incompatible");
    }
    let mut socket = TcpStream::connect(("127.0.0.1", descriptor.port)).map_err(|_| "ling_unavailable")?;
    socket.set_nodelay(true).map_err(|_| "ling_unavailable")?;
    let broker_hello = BrokerHello {
        protocol: NATIVE_PROTOCOL,
        message_type: "hello",
        extension_version: &hello.extension_version,
        browser_version: hello.browser_version.as_deref(),
        paused: hello.paused,
        token: &descriptor.token,
        origin: &origin,
        host_version: HOST_VERSION,
    };
    write_json_frame(&mut socket, &broker_hello).map_err(|_| "ling_unavailable")?;

    let mut writer = socket.try_clone().map_err(|_| "ling_unavailable")?;
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        while let Ok(Some(frame)) = read_frame(&mut stdin) {
            if write_frame(&mut writer, &frame).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Write);
    });

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    while let Some(frame) = read_frame(&mut socket).map_err(|_| "ling_unavailable")? {
        write_frame(&mut stdout, &frame).map_err(|_| "native_protocol_invalid")?;
    }
    Ok(())
}

fn read_descriptor() -> Result<RuntimeDescriptor, Box<dyn std::error::Error>> {
    let path = env::var_os("LING_BROWSER_HOST_RUNTIME_DESCRIPTOR")
        .map(PathBuf::from)
        .unwrap_or_else(default_descriptor_path);
    let metadata = fs::metadata(&path)?;
    if metadata.len() > 16 * 1024 {
        return Err("descriptor too large".into());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn default_descriptor_path() -> PathBuf {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_default();
    PathBuf::from(home).join(".ling-stack").join("browser-host").join("runtime-v1.json")
}

fn now_epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn compatible_version(value: &str) -> bool {
    let mut parts = value.split(|character| character == '.' || character == '-' || character == '+');
    let major = parts.next().and_then(|part| part.parse::<u64>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u64>().ok());
    let patch = parts.next().and_then(|part| part.parse::<u64>().ok());
    matches!((major, minor, patch), (Some(0), Some(1), Some(patch)) if patch >= 1)
        || matches!(major, Some(major) if major >= 1)
}

fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0_u8; 4];
    let mut read = 0;
    while read < length.len() {
        match reader.read(&mut length[read..])? {
            0 if read == 0 => return Ok(None),
            0 => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated native frame length")),
            count => read += count,
        }
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid native frame length"));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid native frame length"));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

fn write_json_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_frame(writer, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_frames_round_trip_and_reject_limits() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, br#"{"ok":true}"#).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice()).unwrap().unwrap(), br#"{"ok":true}"#);
        assert!(write_frame(&mut Vec::new(), &[]).is_err());
        assert!(write_frame(&mut Vec::new(), &vec![0; MAX_MESSAGE_BYTES + 1]).is_err());
    }

    #[test]
    fn native_frames_reject_truncated_payloads() {
        let bytes = [5_u8, 0, 0, 0, b'a'];
        assert!(read_frame(&mut bytes.as_slice()).is_err());
    }

    #[test]
    fn native_frames_handle_eof_and_reject_invalid_read_lengths() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        assert!(read_frame(&mut [1_u8, 0].as_slice()).is_err());
        assert!(read_frame(&mut [0_u8, 0, 0, 0].as_slice()).is_err());
        assert!(read_frame(&mut ((MAX_MESSAGE_BYTES as u32) + 1).to_le_bytes().as_slice()).is_err());
    }

    #[test]
    fn version_compatibility_is_bounded() {
        assert!(compatible_version("0.1.1"));
        assert!(compatible_version("0.1.9"));
        assert!(compatible_version("1.0.0"));
        assert!(!compatible_version("0.1.0"));
        assert!(!compatible_version("invalid"));
    }
}
