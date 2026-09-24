//! Parity harness for the two hashline implementations.
//!
//! Reads length-prefixed (content, patch) pairs on stdin and writes
//! length-prefixed results on stdout, so `tests/parity.test.ts` can feed the
//! same fixtures to this binary and to `packages/tools/src/hashline.ts` and
//! compare the bytes.
//!
//! The framing is deliberately dependency-free — no serde, no JSON — because
//! this exists to prove the two appliers agree, and a shared serialization
//! library would be one more thing that could hide a difference.
//!
//! Protocol, repeated until EOF:
//!
//! ```text
//! CASE <content_len> <patch_len>\n
//! <content bytes><patch bytes>
//! ```
//!
//! Response per case:
//!
//! ```text
//! OK <len>\n<bytes>     — applied, bytes are the new content
//! ERR <len>\n<bytes>    — refused, bytes are the error message
//! ```

use std::io::{self, BufRead, Read, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim();
        if header.is_empty() {
            continue;
        }

        let mut parts = header.split_whitespace();
        match parts.next() {
            Some("CASE") => {}
            Some(other) => {
                writeln!(writer, "ERR 0")?;
                eprintln!("unexpected record {other:?}");
                continue;
            }
            None => continue,
        }

        let content_len: usize = parts
            .next()
            .and_then(|n| n.parse().ok())
            .expect("content length");
        let patch_len: usize = parts
            .next()
            .and_then(|n| n.parse().ok())
            .expect("patch length");

        let mut content = vec![0u8; content_len];
        reader.read_exact(&mut content)?;
        let mut patch = vec![0u8; patch_len];
        reader.read_exact(&mut patch)?;

        let content = String::from_utf8_lossy(&content).into_owned();
        let patch = String::from_utf8_lossy(&patch).into_owned();

        match hashline::patch(&content, &patch) {
            Ok(applied) => {
                let bytes = applied.content.as_bytes();
                write!(writer, "OK {}\n", bytes.len())?;
                writer.write_all(bytes)?;
            }
            Err(err) => {
                let message = err.to_string();
                let bytes = message.as_bytes();
                write!(writer, "ERR {}\n", bytes.len())?;
                writer.write_all(bytes)?;
            }
        }
        writer.flush()?;
    }

    Ok(())
}
