//! `Content-Length` framing, and the pipes and sockets it travels over.
//!
//! LSP and DAP share the same wire format — an HTTP-like header block, a blank
//! line, then exactly that many bytes of JSON — so this module serves both.
//! What differs is the endpoint: most language servers and many debug
//! adapters speak over their own stdio, but several adapters (`dlv dap`,
//! js-debug, CodeLLDB) only listen on a TCP port, and a client that cannot
//! connect to one cannot debug Go or JavaScript at all.

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Reads one framed message body. `Ok(None)` at a clean end of stream.
///
/// Tolerant of what real servers do: header names in any case, extra headers
/// (`Content-Type`), and stray non-header lines some servers print to stdout
/// before their first message — those are skipped rather than taken as a
/// broken stream.
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length: Option<usize> = None;
    let mut line = Vec::new();

    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);

        if text.is_empty() {
            if length.is_some() {
                break;
            }
            // A blank line before any header: noise, not a frame boundary.
            continue;
        }
        if let Some((name, value)) = text.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }

    let mut body = vec![0u8; length.unwrap_or(0)];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one framed message and flushes it: a buffered request is a request
/// the server never sees, which reads as a hang.
pub fn write_message<W: Write + ?Sized>(writer: &mut W, body: &str) -> io::Result<()> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(body.as_bytes());
    writer.write_all(&frame)?;
    writer.flush()
}

/// The last lines a process wrote to stderr, kept for error messages: "the
/// server exited" is useless, "the server exited: cannot find module
/// 'typescript'" is the fix.
#[derive(Clone, Default)]
pub struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl StderrTail {
    const KEEP: usize = 200;

    fn push(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() == Self::KEEP {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    }

    /// The last `count` lines, oldest first.
    pub fn last(&self, count: usize) -> Vec<String> {
        self.lines
            .lock()
            .map(|lines| lines.iter().rev().take(count).rev().cloned().collect())
            .unwrap_or_default()
    }
}

/// A connected endpoint: a reader, a writer, and the process behind them if
/// there is one.
pub struct Wire {
    pub reader: Box<dyn BufRead + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Option<Child>,
    pub stderr: StderrTail,
}

/// A command with `{port}` substituted, for adapters that take their port on
/// the command line.
pub fn with_port(command: &[String], port: u16) -> Vec<String> {
    command.iter().map(|part| part.replace("{port}", &port.to_string())).collect()
}

/// A TCP port free right now on the loopback interface. There is a window
/// between this returning and the adapter binding it; in practice nothing
/// else races for an ephemeral port in that millisecond.
pub fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn command_for(program: &[String], cwd: &Path, env: &[(String, String)]) -> io::Result<Command> {
    let Some((binary, args)) = program.split_first() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty command"));
    };
    let mut command = Command::new(binary);
    command.args(args).current_dir(cwd);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a language server is a background process, and a
        // console window flashing up per server is the first thing a Windows
        // user would notice.
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

fn drain_stderr(stderr: impl Read + Send + 'static, tail: StderrTail) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.split(b'\n').map_while(Result::ok) {
            tail.push(String::from_utf8_lossy(&line).trim_end().to_string());
        }
    });
}

impl Wire {
    /// Starts `program` and talks to it over its stdin and stdout.
    pub fn spawn(program: &[String], cwd: &Path, env: &[(String, String)]) -> io::Result<Wire> {
        let mut command = command_for(program, cwd, env)?;
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn()?;

        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("no stdout"))?;
        let stdin = child.stdin.take().ok_or_else(|| io::Error::other("no stdin"))?;
        let tail = StderrTail::default();
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(stderr, tail.clone());
        }

        Ok(Wire {
            reader: Box::new(BufReader::with_capacity(64 * 1024, stdout)),
            writer: Box::new(stdin),
            child: Some(child),
            stderr: tail,
        })
    }

    /// Connects to something already listening.
    pub fn connect(address: &str, timeout: Duration) -> io::Result<Wire> {
        let target = address
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("no address for {address}")))?;
        let stream = TcpStream::connect_timeout(&target, timeout)?;
        stream.set_nodelay(true).ok();
        let reader = stream.try_clone()?;
        Ok(Wire {
            reader: Box::new(BufReader::with_capacity(64 * 1024, reader)),
            writer: Box::new(stream),
            child: None,
            stderr: StderrTail::default(),
        })
    }

    /// Starts `program` — which listens on `port` — and connects once it is
    /// accepting. Adapters take anywhere from milliseconds (Delve) to a few
    /// seconds (js-debug under a cold Node) to bind, so this retries rather
    /// than failing on the first refused connection.
    pub fn spawn_listening(
        program: &[String],
        cwd: &Path,
        env: &[(String, String)],
        port: u16,
        timeout: Duration,
    ) -> io::Result<Wire> {
        let mut command = command_for(program, cwd, env)?;
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn()?;

        let tail = StderrTail::default();
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(stderr, tail.clone());
        }
        // The adapter's own stdout is not the protocol here; it is log output,
        // and an unread pipe would block the adapter once it fills.
        if let Some(stdout) = child.stdout.take() {
            drain_stderr(stdout, tail.clone());
        }

        let started = Instant::now();
        let address = format!("127.0.0.1:{port}");
        loop {
            match Wire::connect(&address, Duration::from_millis(500)) {
                Ok(mut wire) => {
                    wire.child = Some(child);
                    wire.stderr = tail;
                    return Ok(wire);
                }
                Err(error) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        let said = tail.last(5).join(" | ");
                        return Err(io::Error::other(format!(
                            "exited ({status}) before listening on {port}{}",
                            if said.is_empty() { String::new() } else { format!(": {said}") }
                        )));
                    }
                    if started.elapsed() > timeout {
                        let _ = child.kill();
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("nothing listening on {address} after {timeout:?}: {error}"),
                        ));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_frames_back_to_back_and_skips_noise() {
        let first = r#"{"a":1}"#;
        let second = r#"{"b":"é"}"#;
        let stream = format!(
            "log line from a chatty server\r\n\r\nContent-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{first}content-length: {}\r\n\r\n{second}",
            first.len(),
            second.len()
        );
        let mut reader = Cursor::new(stream.into_bytes());
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), first.as_bytes());
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), second.as_bytes());
        assert!(read_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn writes_the_byte_length_not_the_character_count() {
        let mut out = Vec::new();
        write_message(&mut out, "\"é\"").unwrap();
        assert!(String::from_utf8(out).unwrap().starts_with("Content-Length: 4\r\n\r\n"));
    }

    #[test]
    fn a_port_placeholder_is_filled() {
        let command = vec!["dlv".to_string(), "dap".to_string(), "--listen=127.0.0.1:{port}".to_string()];
        assert_eq!(with_port(&command, 4711)[2], "--listen=127.0.0.1:4711");
    }
}
