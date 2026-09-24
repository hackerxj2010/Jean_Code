//! `file://` URIs and paths.
//!
//! Every path crosses this boundary twice per request, and the failure mode
//! of getting it slightly wrong is silent: the server answers about
//! `file:///c%3A/x.ts` while the client stored diagnostics under
//! `file:///C:/x.ts`, and the agent is told the file is clean. So paths are
//! always compared through [`normalize`], never as the raw strings a server
//! sent.

use std::path::{Path, PathBuf};

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn encode_segment(text: &str, out: &mut String) {
    for &byte in text.as_bytes() {
        if is_unreserved(byte) || matches!(byte, b'/' | b'@' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| (byte as char).to_digit(16);
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The `file://` URI for a path. Relative paths are made absolute against the
/// current directory first; a URI with a relative path is not a URI.
pub fn path_to_uri(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|dir| dir.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut text = absolute.to_string_lossy().replace('\\', "/");
    // Windows verbatim paths — what `canonicalize` returns — name the same
    // file as their plain form, and a server given `file://?/C:/x` finds
    // nothing: `\\?\C:\x` is `C:\x`, `\\?\UNC\host\share` is `\\host\share`.
    if let Some(rest) = text.strip_prefix("//?/") {
        text = match rest.strip_prefix("UNC/") {
            Some(unc) => format!("//{unc}"),
            None => rest.to_string(),
        };
    }

    // UNC: `\\server\share\x` becomes `file://server/share/x`.
    if let Some(rest) = text.strip_prefix("//") {
        let (host, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let mut out = format!("file://{host}/");
        encode_segment(tail, &mut out);
        return out;
    }

    let mut out = String::from("file://");
    let bytes = text.as_bytes();
    // A drive letter: `C:/x` is written `/C:/x`, the colon left as is.
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        out.push('/');
        out.push((bytes[0] as char).to_ascii_uppercase());
        out.push(':');
        encode_segment(&text[2..], &mut out);
    } else {
        encode_segment(&text, &mut out);
    }
    out
}

/// The path a `file://` URI names. Other schemes come back unchanged, as a
/// path that will not exist — which is how an `untitled:` or `jdt://` result
/// is shown rather than crashing the caller.
pub fn uri_to_path(uri: &str) -> PathBuf {
    let Some(rest) = uri.strip_prefix("file://") else {
        return PathBuf::from(uri);
    };
    let (host, path) = match rest.find('/') {
        Some(0) => ("", rest),
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let path = decode(path);

    if !host.is_empty() && host != "localhost" {
        let unc = format!("//{host}{path}");
        return PathBuf::from(if cfg!(windows) { unc.replace('/', "\\") } else { unc });
    }

    let bytes = path.as_bytes();
    // `/c:/x` or `/C:/x` — a drive path, with the leading slash dropped.
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = &path[3..];
        let joined = format!("{drive}:{rest}");
        return PathBuf::from(if cfg!(windows) { joined.replace('/', "\\") } else { joined });
    }
    PathBuf::from(path)
}

/// The canonical spelling of a URI: through a path and back, so two servers'
/// different encodings of one file compare equal.
pub fn normalize(uri: &str) -> String {
    if uri.starts_with("file://") {
        path_to_uri(&uri_to_path(uri))
    } else {
        uri.to_string()
    }
}

/// A path as a key: absolute, separators unified, drive letter upper-cased.
pub fn path_key(path: &Path) -> String {
    uri_to_path(&path_to_uri(path)).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An absolute path on this platform, and the URI prefix it gets.
    fn absolute(unix: &str) -> (PathBuf, &'static str) {
        if cfg!(windows) {
            (PathBuf::from(format!("C:{}", unix.replace('/', "\\"))), "file:///C:")
        } else {
            (PathBuf::from(unix), "file://")
        }
    }

    #[test]
    fn a_path_round_trips_with_escapes() {
        let (path, prefix) = absolute("/home/me/my project/a#b.ts");
        let uri = path_to_uri(&path);
        assert_eq!(uri, format!("{prefix}/home/me/my%20project/a%23b.ts"));
        assert_eq!(uri_to_path(&uri), path);
    }

    #[test]
    fn drive_letters_are_one_spelling_whatever_the_server_sent() {
        assert_eq!(normalize("file:///c%3A/Users/x.ts"), normalize("file:///C:/Users/x.ts"));
        let path = uri_to_path("file:///d%3A/ProjetsIA/x.rs");
        assert!(path.to_string_lossy().starts_with("D:"));
    }

    #[test]
    fn non_ascii_is_percent_encoded_as_utf8() {
        let (path, prefix) = absolute("/tmp/résumé.md");
        let uri = path_to_uri(&path);
        assert_eq!(uri, format!("{prefix}/tmp/r%C3%A9sum%C3%A9.md"));
        assert_eq!(uri_to_path(&uri), path);
    }

    #[test]
    #[cfg(windows)]
    fn verbatim_windows_paths_are_their_plain_selves() {
        assert_eq!(path_to_uri(Path::new(r"\\?\C:\Users\x.ts")), "file:///C:/Users/x.ts");
        assert_eq!(path_to_uri(Path::new(r"\\?\UNC\host\share\x.ts")), "file://host/share/x.ts");
    }

    #[test]
    fn other_schemes_pass_through() {
        assert_eq!(uri_to_path("untitled:Untitled-1"), PathBuf::from("untitled:Untitled-1"));
    }
}
