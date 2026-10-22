#[cfg(any(windows, test))]
mod protocol;
#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    match windows::run() {
        Ok(code) => std::process::exit(code),
        Err(_) => {
            eprintln!("engine_supervisor_failed");
            std::process::exit(125);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("engine_supervisor_unsupported_platform");
        std::process::exit(125);
    }
}
