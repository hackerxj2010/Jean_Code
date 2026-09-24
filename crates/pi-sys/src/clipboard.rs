//! The system clipboard (architecture §6.1 `clipboard`).
//!
//! Two paths, and the second is the one that matters for an agent.
//!
//! **Local**: the platform's own tool — `clip`/PowerShell on Windows,
//! `pbcopy`/`pbpaste` on macOS, `wl-copy` or `xclip` on Linux. Std-only, no
//! `arboard`, because the whole job is spawning a process with a pipe.
//!
//! **Remote**: OSC 52, an escape sequence that asks the *terminal* to set its
//! clipboard. This is what works over SSH, inside tmux, and in a container —
//! everywhere the local tools would set a clipboard nobody can see. An agent
//! runs in exactly those places, so OSC 52 is not a fallback here, it is the
//! primary path when the session is remote.

use std::io::Write;
use std::process::{Command, Stdio};

/// How the clipboard was reached, so a caller can report it honestly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// A local platform tool.
    Native,
    /// An OSC 52 sequence written to the terminal.
    Osc52,
    /// Nothing available.
    None,
}

impl Backend {
    pub fn label(&self) -> &'static str {
        match self {
            Backend::Native => "system clipboard",
            Backend::Osc52 => "terminal clipboard (OSC 52)",
            Backend::None => "unavailable",
        }
    }
}

/// The largest payload OSC 52 will carry.
///
/// Terminals silently truncate or drop an oversized sequence, and a clipboard
/// holding half a file is worse than a refusal that says why. 100 KB is well
/// under what every terminal tested accepts.
pub const MAX_OSC52_BYTES: usize = 100_000;

/// Whether this session is reaching a terminal on another machine.
///
/// OSC 52 is preferred there: the local tools would set a clipboard on the
/// remote host, which the person sitting in front of the terminal cannot use.
pub fn is_remote(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env("SSH_CONNECTION").is_some() || env("SSH_TTY").is_some() || env("SSH_CLIENT").is_some()
}

/// Copies text to the clipboard, choosing the path that will actually be seen.
pub fn copy(text: &str) -> Result<Backend, String> {
    let lookup = |name: &str| std::env::var(name).ok();

    if is_remote(&lookup) {
        return copy_osc52(text).map(|()| Backend::Osc52);
    }

    match copy_native(text) {
        Ok(()) => Ok(Backend::Native),
        // Falling through rather than failing: a Linux box with no `xclip`
        // installed may still be attached to a terminal that honours OSC 52.
        Err(native_error) => match copy_osc52(text) {
            Ok(()) => Ok(Backend::Osc52),
            Err(osc_error) => Err(format!("{native_error}; OSC 52 also failed: {osc_error}")),
        },
    }
}

/// Reads the clipboard.
///
/// Local only. OSC 52 can request a read, but the terminal answers on stdin —
/// which an interface in raw mode is already consuming as keystrokes, and
/// which most terminals disable by default because it lets any program running
/// in them exfiltrate whatever the user last copied.
pub fn paste() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let attempt = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
        .output();

    #[cfg(target_os = "macos")]
    let attempt = Command::new("pbpaste").output();

    #[cfg(all(unix, not(target_os = "macos")))]
    let attempt = Command::new("wl-paste")
        .arg("--no-newline")
        .output()
        .or_else(|_| Command::new("xclip").args(["-selection", "clipboard", "-o"]).output())
        .or_else(|_| Command::new("xsel").args(["--clipboard", "--output"]).output());

    match attempt {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Err(error) => Err(format!("no clipboard tool available: {error}")),
    }
}

/// Writes through the platform's own tool.
fn copy_native(text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut child = Command::new("clip")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut child = spawn_linux_copy()?;

    {
        let stdin = child.stdin.as_mut().ok_or("the clipboard tool refused a pipe")?;
        stdin.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("the clipboard tool exited with {status}"))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_linux_copy() -> Result<std::process::Child, String> {
    // Wayland first: on a Wayland session `xclip` may exist but writes to an
    // XWayland clipboard that native applications do not read.
    let attempts: [(&str, &[&str]); 3] = [
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];

    for (program, args) in attempts {
        if let Ok(child) = Command::new(program).args(args).stdin(Stdio::piped()).spawn() {
            return Ok(child);
        }
    }

    Err("none of wl-copy, xclip, or xsel is installed".to_string())
}

/// Asks the terminal to set its clipboard, via OSC 52.
pub fn copy_osc52(text: &str) -> Result<(), String> {
    if text.len() > MAX_OSC52_BYTES {
        return Err(format!(
            "{} bytes is too long for OSC 52 (limit {MAX_OSC52_BYTES}); terminals truncate silently",
            text.len()
        ));
    }

    let sequence = osc52_sequence(text, in_tmux(&|name| std::env::var(name).ok()));

    // Written to the controlling terminal rather than stdout: stdout may be a
    // pipe, and a clipboard sequence in a redirected log reaches no terminal
    // and corrupts the file.
    write_to_terminal(&sequence)
}

/// Builds the escape sequence.
///
/// Split out because it is the part worth testing — the wrapping is easy to get
/// subtly wrong, and a malformed sequence prints as garbage in the user's
/// terminal rather than failing.
pub fn osc52_sequence(text: &str, tmux: bool) -> String {
    const ESC: char = '\u{1b}';
    const BEL: char = '\u{7}';

    let payload = base64(text.as_bytes());
    let inner = format!("{ESC}]52;c;{payload}{BEL}");

    if !tmux {
        return inner;
    }

    // tmux intercepts escape sequences from the programs it hosts, so one
    // meant for the outer terminal has to be wrapped in a DCS passthrough with
    // every ESC doubled.
    let escaped = inner.replace(ESC, &format!("{ESC}{ESC}"));
    format!("{ESC}Ptmux;{escaped}{ESC}\\")
}

pub fn in_tmux(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env("TMUX").is_some()
}

fn write_to_terminal(sequence: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        let mut tty = OpenOptions::new()
            .write(true)
            .open("/dev/tty")
            .map_err(|error| format!("no terminal to write to: {error}"))?;
        tty.write_all(sequence.as_bytes()).map_err(|error| error.to_string())?;
        tty.flush().map_err(|error| error.to_string())
    }

    #[cfg(not(unix))]
    {
        // Windows has no `/dev/tty`; stdout is the terminal when one is
        // attached, and the caller checked that before reaching here.
        let mut out = std::io::stdout();
        out.write_all(sequence.as_bytes()).map_err(|error| error.to_string())?;
        out.flush().map_err(|error| error.to_string())
    }
}

/// Standard base64. Written out because pulling a crate for forty lines that
/// this repository already needs elsewhere would be the wrong trade.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn base64_matches_the_published_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn an_osc52_sequence_carries_the_payload() {
        let sequence = osc52_sequence("hello", false);

        assert!(sequence.starts_with("\u{1b}]52;c;"));
        assert!(sequence.ends_with('\u{7}'));
        assert!(sequence.contains("aGVsbG8="));
    }

    #[test]
    fn tmux_gets_a_passthrough_with_doubled_escapes() {
        // Without this, tmux swallows the sequence and the clipboard never
        // changes — with no error, which is the hard part to diagnose.
        let sequence = osc52_sequence("hello", true);

        assert!(sequence.starts_with("\u{1b}Ptmux;"));
        assert!(sequence.ends_with("\u{1b}\\"));
        assert!(sequence.contains("\u{1b}\u{1b}]52"));
    }

    #[test]
    fn an_oversized_payload_is_refused_rather_than_truncated() {
        let huge = "x".repeat(MAX_OSC52_BYTES + 1);
        let error = copy_osc52(&huge).unwrap_err();

        assert!(error.contains("too long"), "{error}");
        // The message says what the limit is, so the caller can chunk.
        assert!(error.contains(&MAX_OSC52_BYTES.to_string()));
    }

    #[test]
    fn ssh_is_detected_from_any_of_its_variables() {
        assert!(is_remote(&env_with(&[("SSH_CONNECTION", "1.2.3.4 22")])));
        assert!(is_remote(&env_with(&[("SSH_TTY", "/dev/pts/0")])));
        assert!(is_remote(&env_with(&[("SSH_CLIENT", "1.2.3.4")])));
        assert!(!is_remote(&env_with(&[("TERM", "xterm")])));
    }

    #[test]
    fn tmux_is_detected() {
        assert!(in_tmux(&env_with(&[("TMUX", "/tmp/tmux-1000/default,123,0")])));
        assert!(!in_tmux(&env_with(&[])));
    }

    #[test]
    fn a_backend_names_itself_for_a_report() {
        assert_eq!(Backend::Native.label(), "system clipboard");
        assert!(Backend::Osc52.label().contains("OSC 52"));
        assert_eq!(Backend::None.label(), "unavailable");
    }

    #[test]
    fn unicode_survives_the_encoding() {
        // A naive byte-at-a-time encoder mangles multi-byte characters, and the
        // failure only shows up when someone copies a non-English string.
        let sequence = osc52_sequence("héllo 😀", false);
        let payload = sequence
            .trim_start_matches("\u{1b}]52;c;")
            .trim_end_matches('\u{7}');

        assert_eq!(payload, base64("héllo 😀".as_bytes()));
    }
}
