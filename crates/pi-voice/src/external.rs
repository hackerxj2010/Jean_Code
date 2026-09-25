//! What pi-voice reaches through programs already on the machine: `ffmpeg`
//! for the lossy codecs, and the system's recorders for the microphone.
//!
//! Capture through a recorder rather than through CoreAudio, WASAPI, or ALSA
//! directly keeps this crate free of platform linkage — and every machine
//! that can record has one of these: `parecord` or `arecord` on Linux,
//! `sox` anywhere it is installed, `ffmpeg` everywhere. Each is asked for the
//! same thing — 16 kHz mono 16-bit PCM on stdout — so what follows is one
//! code path: the samples are read as they arrive, the turn detector
//! listens, and recording stops when the speaker has finished.

use crate::{Frame, Turn, TurnDetector};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The rate everything is captured at: what speech models want.
pub const CAPTURE_RATE: u32 = 16_000;

/// Decodes anything `ffmpeg` can — MP3, Ogg Vorbis and Opus, AAC, WebM —
/// into a frame.
pub fn transcode(path: &Path) -> Result<Frame, String> {
    let ffmpeg = program("ffmpeg").ok_or("ffmpeg is not installed, and it is what decodes this format")?;
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-f", "wav", "-acodec", "pcm_s16le", "-"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg could not start: {error}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        let reason = said.trim().lines().last().unwrap_or("no reason given").to_string();
        return Err(format!("ffmpeg could not decode {}: {reason}", path.display()));
    }
    // ffmpeg writing to a pipe cannot go back to fill in the sizes; the WAV
    // decoder reads what is there.
    crate::wav::decode(&output.stdout)
}

/// A program on PATH, with Windows' executable extensions tried.
pub fn program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    std::env::split_paths(&path).find_map(|directory| {
        extensions.iter().map(|extension| directory.join(format!("{name}{extension}"))).find(|candidate| candidate.is_file())
    })
}

/// A way to record from the microphone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorder {
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

/// The recorders this machine has, most suitable first. `JEAN_RECORDER`,
/// a command that writes 16 kHz mono 16-bit little-endian PCM to stdout,
/// comes before all of them.
pub fn recorders() -> Vec<Recorder> {
    let mut found = Vec::new();
    if let Ok(custom) = std::env::var("JEAN_RECORDER") {
        let mut parts = custom.split_whitespace();
        if let Some(head) = parts.next() {
            found.push(Recorder { name: "custom".into(), program: PathBuf::from(head), args: parts.map(String::from).collect() });
        }
    }
    let rate = CAPTURE_RATE.to_string();
    let mut add = |name: &str, args: Vec<String>| {
        if let Some(program) = program(name) {
            found.push(Recorder { name: name.to_string(), program, args });
        }
    };
    if cfg!(target_os = "linux") {
        add("parecord", strings(&["--raw", "--format=s16le", &format!("--rate={rate}"), "--channels=1"]));
        add("arecord", strings(&["-q", "-f", "S16_LE", "-r", &rate, "-c", "1", "-t", "raw"]));
    }
    add("sox", strings(&["-q", "-d", "-t", "raw", "-r", &rate, "-e", "signed-integer", "-b", "16", "-c", "1", "-"]));
    if let Some(input) = ffmpeg_input() {
        let mut args = strings(&["-hide_banner", "-loglevel", "error", "-nostdin"]);
        args.extend(input);
        args.extend(strings(&["-ac", "1", "-ar", &rate, "-f", "s16le", "-"]));
        add("ffmpeg", args);
    }
    found
}

/// ffmpeg's input for the default microphone on this platform.
fn ffmpeg_input() -> Option<Vec<String>> {
    if cfg!(target_os = "macos") {
        return Some(strings(&["-f", "avfoundation", "-i", ":0"]));
    }
    if cfg!(target_os = "linux") {
        let pulse = program("pactl").is_some() || program("pipewire").is_some();
        return Some(strings(&["-f", if pulse { "pulse" } else { "alsa" }, "-i", "default"]));
    }
    if cfg!(windows) {
        // DirectShow names devices, and has no "default": ask for the list.
        let listed = Command::new(program("ffmpeg")?)
            .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let device = dshow_microphone(&String::from_utf8_lossy(&listed.stderr))?;
        return Some(vec!["-f".into(), "dshow".into(), "-i".into(), format!("audio={device}")]);
    }
    None
}

/// The first audio device in ffmpeg's DirectShow listing.
pub fn dshow_microphone(listing: &str) -> Option<String> {
    listing.lines().filter(|line| line.contains("(audio)")).find_map(|line| {
        let start = line.find('"')? + 1;
        let end = start + line[start..].find('"')?;
        Some(line[start..end].to_string())
    })
}

/// When to stop recording.
#[derive(Debug, Clone, Copy)]
pub struct Capture {
    /// The longest recording.
    pub max_ms: u32,
    /// Stop once the speaker has finished — speech, then a pause.
    pub until_silence: bool,
    /// Give up if nobody has spoken after this long.
    pub wait_ms: u32,
}

impl Default for Capture {
    fn default() -> Self {
        Capture { max_ms: 60_000, until_silence: true, wait_ms: 10_000 }
    }
}

/// What a recording captured.
#[derive(Debug, Clone)]
pub struct Recording {
    pub frame: Frame,
    pub recorder: String,
    /// Whether speech was heard at all.
    pub heard_speech: bool,
}

/// Records from the microphone with the first recorder that works.
pub fn record(options: Capture) -> Result<Recording, String> {
    let available = recorders();
    if available.is_empty() {
        return Err("no audio recorder is installed: install ffmpeg or sox (on Linux, arecord or parecord also work)".to_string());
    }
    let mut failures = Vec::new();
    for recorder in available {
        match record_with(&recorder, options) {
            Ok(recording) => return Ok(recording),
            Err(error) => failures.push(format!("{}: {error}", recorder.name)),
        }
    }
    Err(format!("recording failed — {}", failures.join("; ")))
}

fn record_with(recorder: &Recorder, options: Capture) -> Result<Recording, String> {
    let mut child = Command::new(&recorder.program)
        .args(&recorder.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start: {error}"))?;
    let stderr = child.stderr.take();
    let complaints = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let stdout = child.stdout.take().ok_or("no output from the recorder")?;
    let captured = listen(stdout, options);
    let _ = child.kill();
    let _ = child.wait();
    let said = complaints.join().unwrap_or_default();
    let (frame, heard_speech) = captured?;
    if frame.samples.is_empty() {
        return Err(said.trim().lines().last().unwrap_or("it produced no audio").to_string());
    }
    Ok(Recording { frame, recorder: recorder.name.clone(), heard_speech })
}

/// Reads 16 kHz mono PCM from `source` until the speaker finishes, the time
/// runs out, or the stream ends. Returns the audio and whether it held speech.
pub fn listen(mut source: impl Read, options: Capture) -> Result<(Frame, bool), String> {
    let started = Instant::now();
    let mut detector = TurnDetector::default();
    let mut samples: Vec<i16> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 3200]; // 100 ms
    let window = (CAPTURE_RATE / 50) as usize; // 20 ms
    let mut examined = 0;
    let mut heard = false;
    loop {
        let read = source.read(&mut buffer).map_err(|error| format!("reading the recording failed: {error}"))?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..read]);
        let whole = pending.len() / 2 * 2;
        samples.extend(pending[..whole].chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]])));
        pending.drain(..whole);

        let mut ended = false;
        while examined + window <= samples.len() {
            let piece = Frame::new(samples[examined..examined + window].to_vec(), CAPTURE_RATE, 1);
            examined += window;
            match detector.push(&piece) {
                Turn::Speaking => heard = true,
                Turn::Ended => {
                    heard = true;
                    ended = true;
                }
                Turn::Waiting => {}
            }
        }
        let elapsed_ms = samples.len() as u64 * 1000 / u64::from(CAPTURE_RATE);
        if (options.until_silence && ended)
            || elapsed_ms >= u64::from(options.max_ms)
            || (!heard && elapsed_ms >= u64::from(options.wait_ms))
            || started.elapsed() > Duration::from_millis(u64::from(options.max_ms) + 5_000)
        {
            break;
        }
    }
    Ok((Frame::new(samples, CAPTURE_RATE, 1), heard))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn pcm(frame: &Frame) -> Vec<u8> {
        frame.samples.iter().flat_map(|sample| sample.to_le_bytes()).collect()
    }

    fn tone(duration_ms: u32) -> Frame {
        let count = (CAPTURE_RATE * duration_ms / 1000) as usize;
        let samples = (0..count).map(|i| ((i as f64 / 16.0 * std::f64::consts::TAU).sin() * 12_000.0) as i16).collect();
        Frame::new(samples, CAPTURE_RATE, 1)
    }

    #[test]
    fn recording_stops_when_the_speaker_finishes() {
        let mut stream = pcm(&Frame::silent(500, CAPTURE_RATE));
        stream.extend(pcm(&tone(1500)));
        stream.extend(pcm(&Frame::silent(3000, CAPTURE_RATE)));
        stream.extend(pcm(&tone(1000)));
        let (frame, heard) = listen(Cursor::new(stream), Capture::default()).unwrap();
        assert!(heard);
        // Half a second of waiting, the speech, and about the hangover — not
        // the later speech.
        let duration = frame.duration_ms();
        assert!((2600..3000).contains(&duration), "{duration} ms");
    }

    #[test]
    fn recording_gives_up_on_silence_and_respects_the_limit() {
        let silence = pcm(&Frame::silent(20_000, CAPTURE_RATE));
        let (frame, heard) = listen(Cursor::new(silence), Capture { wait_ms: 2_000, ..Capture::default() }).unwrap();
        assert!(!heard);
        assert!(frame.duration_ms() <= 2_100);

        let speech = pcm(&tone(10_000));
        let (frame, _) = listen(Cursor::new(speech), Capture { max_ms: 3_000, ..Capture::default() }).unwrap();
        assert!(frame.duration_ms() <= 3_100);
    }

    #[test]
    fn the_dshow_listing_names_the_microphone() {
        let listing = "[dshow @ 0x1] \"Integrated Camera\" (video)\n[dshow @ 0x1] \"Microphone Array (Realtek(R) Audio)\" (audio)\n";
        assert_eq!(dshow_microphone(listing).as_deref(), Some("Microphone Array (Realtek(R) Audio)"));
        assert_eq!(dshow_microphone("nothing here"), None);
    }
}
