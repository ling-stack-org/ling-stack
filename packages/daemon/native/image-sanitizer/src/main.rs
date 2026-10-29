mod budget;
use ling_image_sanitizer::{MAX_BYTES, MAX_PIXELS, sanitize, sanitize_background};
use std::io::{Read, Write};

#[global_allocator]
static ALLOCATOR: budget::Budgeted = budget::Budgeted;

fn main() {
    // Codec messages and panic payloads can include input data; expose fixed status only.
    std::panic::set_hook(Box::new(|_| {}));
    let result = run();
    match result {
        Ok(()) => {}
        Err(code) => {
            let _ = std::io::stderr().write_all(match code {
                3 => b"unsupported_artifact\n",
                4 => b"capacity_exceeded\n",
                _ => b"invalid_artifact\n",
            });
            std::process::exit(code);
        }
    }
}

fn run() -> Result<(), i32> {
    let mut args = std::env::args_os().skip(1);
    let arg = args.next().and_then(|s| s.into_string().ok()).ok_or(2)?;
    let background = match args.next() {
        None => false,
        Some(flag) if flag == "--background" => true,
        _ => return Err(2),
    };
    if args.next().is_some()
        || arg.is_empty()
        || arg.len() > 8
        || !arg.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(2);
    }
    let max_pixels = arg.parse::<u64>().map_err(|_| 2)?;
    if !(1..=MAX_PIXELS).contains(&max_pixels) {
        return Err(4);
    }
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| 2)?;
    if input.len() > MAX_BYTES {
        return Err(4);
    }
    let output = if background {
        sanitize_background(&input, max_pixels)
    } else {
        sanitize(&input, max_pixels)
    }
    .map_err(|e| e.code())?;
    std::io::stdout().lock().write_all(&output).map_err(|_| 2)
}
