//! Decoders for the audio formats besides WAV that recordings come in:
//! FLAC (lossless, what a careful recording is archived as), AIFF (what
//! macOS records), Sun `.au`, and the G.711 μ-law and A-law of telephony.
//!
//! All are pure computation over bytes, like the WAV decoder. Compressed
//! lossy formats — MP3, Ogg Vorbis and Opus, AAC — are thousands of lines of
//! codec each; those go through `ffmpeg` when it is installed (see
//! `external`), and a speech-to-text service takes most of them as they are.

use crate::Frame;

/// A decoded recording, and what it was.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub frame: Frame,
    /// `wav`, `flac`, `aiff`, `au`.
    pub format: &'static str,
    pub bits_per_sample: u16,
}

/// The format a file's first bytes announce, if it is one of ours.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => Some("wav"),
        [b'f', b'L', b'a', b'C', ..] => Some("flac"),
        [b'F', b'O', b'R', b'M', _, _, _, _, b'A', b'I', b'F', b'F' | b'C', ..] => Some("aiff"),
        [b'.', b's', b'n', b'd', ..] => Some("au"),
        _ => None,
    }
}

/// Decodes any format this crate reads.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    match sniff(bytes) {
        Some("wav") => {
            let format = crate::wav::probe(bytes)?;
            Ok(Decoded { frame: crate::wav::decode(bytes)?, format: "wav", bits_per_sample: format.bits_per_sample })
        }
        Some("flac") => decode_flac(bytes),
        Some("aiff") => decode_aiff(bytes),
        Some("au") => decode_au(bytes),
        _ => Err(format!("not a format pi-voice decodes ({})", describe(bytes))),
    }
}

/// A guess at what an unsupported file is, for the error message.
fn describe(bytes: &[u8]) -> &'static str {
    match bytes {
        [b'I', b'D', b'3', ..] | [0xFF, 0xE0..=0xFF, ..] => "MP3",
        [b'O', b'g', b'g', b'S', ..] => "Ogg (Vorbis or Opus)",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "MP4/M4A",
        [0x1A, 0x45, 0xDF, 0xA3, ..] => "WebM/Matroska",
        _ => "unknown format",
    }
}

// ---- G.711 ------------------------------------------------------------------

/// μ-law, as North American telephony and `.au` files carry it.
pub fn ulaw(byte: u8) -> i16 {
    let u = !byte;
    let exponent = (u >> 4) & 0x07;
    let mantissa = i32::from(u & 0x0F);
    let magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    (if u & 0x80 != 0 { -magnitude } else { magnitude }) as i16
}

/// A-law, as European telephony carries it.
pub fn alaw(byte: u8) -> i16 {
    let a = byte ^ 0x55;
    let exponent = (a >> 4) & 0x07;
    let mantissa = i32::from(a & 0x0F);
    let magnitude = if exponent == 0 { (mantissa << 4) + 8 } else { ((mantissa << 4) + 0x108) << (exponent - 1) };
    (if a & 0x80 != 0 { magnitude } else { -magnitude }) as i16
}

// ---- big-endian PCM, shared by AIFF and .au ------------------------------------

fn pcm_be(data: &[u8], bits: u16) -> Result<Vec<i16>, String> {
    Ok(match bits {
        8 => data.iter().map(|b| i16::from(*b as i8) << 8).collect(),
        16 => data.chunks_exact(2).map(|p| i16::from_be_bytes([p[0], p[1]])).collect(),
        24 => data.chunks_exact(3).map(|p| i16::from_be_bytes([p[0], p[1]])).collect(),
        32 => data.chunks_exact(4).map(|p| i16::from_be_bytes([p[0], p[1]])).collect(),
        other => return Err(format!("unsupported bit depth: {other}")),
    })
}

fn float_to_i16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

// ---- AIFF -------------------------------------------------------------------

/// The 80-bit extended float AIFF stores its sample rate in.
fn extended(bytes: &[u8]) -> f64 {
    let exponent = i32::from(u16::from_be_bytes([bytes[0], bytes[1]]) & 0x7FFF);
    let mantissa = u64::from_be_bytes(bytes[2..10].try_into().unwrap_or([0; 8]));
    if exponent == 0 && mantissa == 0 {
        return 0.0;
    }
    let value = mantissa as f64 * 2f64.powi(exponent - 16383 - 63);
    if bytes[0] & 0x80 != 0 {
        -value
    } else {
        value
    }
}

pub fn decode_aiff(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < 12 {
        return Err("too short to be an AIFF file".to_string());
    }
    let compressed = &bytes[8..12] == b"AIFC";
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut rate = 0f64;
    let mut compression = *b"NONE";
    let mut sound: Option<&[u8]> = None;
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_be_bytes(bytes[offset + 4..offset + 8].try_into().unwrap_or([0; 4])) as usize;
        let start = offset + 8;
        let end = (start + size).min(bytes.len());
        let body = &bytes[start..end];
        match id {
            b"COMM" if body.len() >= 18 => {
                channels = u16::from_be_bytes([body[0], body[1]]).max(1);
                bits = u16::from_be_bytes([body[6], body[7]]);
                rate = extended(&body[8..18]);
                if compressed && body.len() >= 22 {
                    compression.copy_from_slice(&body[18..22]);
                }
            }
            b"SSND" if body.len() >= 8 => {
                let skip = u32::from_be_bytes(body[0..4].try_into().unwrap_or([0; 4])) as usize;
                sound = Some(&body[(8 + skip).min(body.len())..]);
            }
            _ => {}
        }
        offset = start + size + (size % 2);
    }
    let data = sound.ok_or("no SSND chunk")?;
    if channels == 0 {
        return Err("no COMM chunk".to_string());
    }
    let samples = match &compression {
        b"NONE" | b"twos" => pcm_be(data, bits)?,
        // `sowt` is AIFF-C's little-endian 16-bit PCM.
        b"sowt" => data.chunks_exact(2).map(|p| i16::from_le_bytes([p[0], p[1]])).collect(),
        b"fl32" | b"FL32" => data.chunks_exact(4).map(|p| float_to_i16(f32::from_be_bytes([p[0], p[1], p[2], p[3]]))).collect(),
        b"ulaw" | b"ULAW" => data.iter().map(|b| ulaw(*b)).collect(),
        b"alaw" | b"ALAW" => data.iter().map(|b| alaw(*b)).collect(),
        other => return Err(format!("unsupported AIFF-C compression `{}`", String::from_utf8_lossy(other))),
    };
    Ok(Decoded {
        frame: Frame::new(samples, rate.round().max(1.0) as u32, channels),
        format: "aiff",
        bits_per_sample: bits.max(8),
    })
}

// ---- Sun .au ------------------------------------------------------------------

pub fn decode_au(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < 24 {
        return Err("too short to be an .au file".to_string());
    }
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap_or([0; 4]));
    let start = (word(4) as usize).min(bytes.len());
    let size = word(8);
    let end = if size == u32::MAX { bytes.len() } else { (start + size as usize).min(bytes.len()) };
    let data = &bytes[start..end];
    let (samples, bits) = match word(12) {
        1 => (data.iter().map(|b| ulaw(*b)).collect(), 8),
        2 => (pcm_be(data, 8)?, 8),
        3 => (pcm_be(data, 16)?, 16),
        4 => (pcm_be(data, 24)?, 24),
        5 => (pcm_be(data, 32)?, 32),
        6 => (data.chunks_exact(4).map(|p| float_to_i16(f32::from_be_bytes([p[0], p[1], p[2], p[3]]))).collect(), 32),
        27 => (data.iter().map(|b| alaw(*b)).collect(), 8),
        other => return Err(format!("unsupported .au encoding {other}")),
    };
    Ok(Decoded { frame: Frame::new(samples, word(16).max(1), (word(20) as u16).max(1)), format: "au", bits_per_sample: bits })
}

// ---- FLAC -------------------------------------------------------------------

/// A reader of big-endian bit fields, as FLAC packs everything.
struct Bits<'a> {
    data: &'a [u8],
    /// Position in bits.
    pos: usize,
}

const EOF: &str = "the FLAC stream ends in the middle of a frame";

impl Bits<'_> {
    fn read(&mut self, mut count: u32) -> Result<u64, String> {
        let mut value = 0u64;
        while count > 0 {
            let byte = u32::from(*self.data.get(self.pos >> 3).ok_or(EOF)?);
            let offset = (self.pos & 7) as u32;
            let available = 8 - offset;
            let take = available.min(count);
            let chunk = (byte >> (available - take)) & ((1u32 << take) - 1);
            value = (value << take) | u64::from(chunk);
            self.pos += take as usize;
            count -= take;
        }
        Ok(value)
    }

    fn signed(&mut self, count: u32) -> Result<i64, String> {
        if count == 0 {
            return Ok(0);
        }
        let value = self.read(count)?;
        let shift = 64 - count;
        Ok(((value << shift) as i64) >> shift)
    }

    /// Zeros before the next one bit — the quotient of a Rice code.
    fn unary(&mut self) -> Result<u32, String> {
        let mut zeros = 0;
        loop {
            let byte = *self.data.get(self.pos >> 3).ok_or(EOF)?;
            let offset = self.pos & 7;
            let rest = u32::from(byte << offset);
            if rest == 0 {
                zeros += (8 - offset) as u32;
                self.pos += 8 - offset;
                continue;
            }
            let leading = rest.leading_zeros() - 24;
            zeros += leading;
            self.pos += leading as usize + 1;
            return Ok(zeros);
        }
    }

    fn align(&mut self) {
        self.pos = (self.pos + 7) & !7;
    }
}

struct StreamInfo {
    sample_rate: u32,
    channels: u16,
    bits: u32,
}

pub fn decode_flac(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < 8 || &bytes[0..4] != b"fLaC" {
        return Err("not a FLAC file".to_string());
    }
    // Metadata blocks: STREAMINFO first, then any others, until the last.
    let mut offset = 4;
    let mut info: Option<StreamInfo> = None;
    loop {
        let short = || "the FLAC metadata is cut short".to_string();
        let header = *bytes.get(offset).ok_or_else(short)?;
        let length = bytes.get(offset + 1..offset + 4).ok_or_else(short)?;
        let length = (usize::from(length[0]) << 16) | (usize::from(length[1]) << 8) | usize::from(length[2]);
        let body = bytes.get(offset + 4..offset + 4 + length).ok_or_else(short)?;
        if header & 0x7F == 0 && body.len() >= 18 {
            let mut bits = Bits { data: &body[10..], pos: 0 };
            let sample_rate = bits.read(20)? as u32;
            let channels = bits.read(3)? as u16 + 1;
            let depth = bits.read(5)? as u32 + 1;
            info = Some(StreamInfo { sample_rate, channels, bits: depth });
        }
        offset += 4 + length;
        if header & 0x80 != 0 {
            break;
        }
    }
    let info = info.ok_or("the FLAC file has no STREAMINFO")?;

    let mut channels: Vec<Vec<i32>> = vec![Vec::new(); usize::from(info.channels)];
    let mut depth = info.bits;
    let mut rate = info.sample_rate;
    while offset + 2 <= bytes.len() {
        // Every frame starts on the sync code; anything else is skipped.
        if !(bytes[offset] == 0xFF && bytes[offset + 1] & 0xFE == 0xF8) {
            offset += 1;
            continue;
        }
        match decode_frame(bytes, offset, &info) {
            Ok((decoded, next, frame_bits, frame_rate)) => {
                for (channel, samples) in channels.iter_mut().zip(decoded) {
                    channel.extend(samples);
                }
                depth = frame_bits;
                if frame_rate > 0 {
                    rate = frame_rate;
                }
                offset = next;
            }
            // A false sync inside audio data: look further.
            Err(_) => offset += 1,
        }
    }

    let to_i16 = |sample: i32| -> i16 {
        if depth >= 16 {
            (sample >> (depth - 16)) as i16
        } else {
            (sample << (16 - depth)) as i16
        }
    };
    let count = channels.first().map_or(0, Vec::len);
    let mut samples = Vec::with_capacity(count * channels.len());
    for index in 0..count {
        for channel in &channels {
            samples.push(to_i16(channel.get(index).copied().unwrap_or(0)));
        }
    }
    Ok(Decoded { frame: Frame::new(samples, rate.max(1), info.channels), format: "flac", bits_per_sample: depth as u16 })
}

type FrameSamples = (Vec<Vec<i32>>, usize, u32, u32);

/// One frame: its samples per channel, where the next frame starts, and its
/// bit depth and sample rate.
fn decode_frame(bytes: &[u8], start: usize, info: &StreamInfo) -> Result<FrameSamples, String> {
    let mut bits = Bits { data: bytes, pos: start * 8 };
    bits.read(15)?; // sync and a reserved bit
    bits.read(1)?; // blocking strategy
    let block_code = bits.read(4)? as u32;
    let rate_code = bits.read(4)? as u32;
    let assignment = bits.read(4)? as u32;
    let size_code = bits.read(3)? as u32;
    if bits.read(1)? != 0 {
        return Err("reserved bit set".to_string());
    }
    // The frame or sample number, UTF-8 coded.
    let first = bits.read(8)? as u8;
    if first.leading_ones() == 1 || first.leading_ones() > 7 {
        return Err("bad frame number".to_string());
    }
    for _ in 0..first.leading_ones().saturating_sub(1) {
        bits.read(8)?;
    }
    let block = match block_code {
        0 => return Err("reserved block size".to_string()),
        1 => 192,
        2..=5 => 576 << (block_code - 2),
        6 => bits.read(8)? as usize + 1,
        7 => bits.read(16)? as usize + 1,
        _ => 256 << (block_code - 8),
    };
    let rate = match rate_code {
        0 => info.sample_rate,
        1 => 88_200,
        2 => 176_400,
        3 => 192_000,
        4 => 8_000,
        5 => 16_000,
        6 => 22_050,
        7 => 24_000,
        8 => 32_000,
        9 => 44_100,
        10 => 48_000,
        11 => 96_000,
        12 => bits.read(8)? as u32 * 1000,
        13 => bits.read(16)? as u32,
        14 => bits.read(16)? as u32 * 10,
        _ => return Err("bad sample rate".to_string()),
    };
    let depth = match size_code {
        0 => info.bits,
        1 => 8,
        2 => 12,
        4 => 16,
        5 => 20,
        6 => 24,
        7 => 32,
        _ => return Err("reserved sample size".to_string()),
    };
    bits.read(8)?; // header CRC-8

    let count = if assignment <= 7 { assignment as usize + 1 } else { 2 };
    if assignment > 10 || count != usize::from(info.channels) {
        return Err("bad channel assignment".to_string());
    }
    let mut channels = Vec::with_capacity(count);
    for channel in 0..count {
        // The side channel of a stereo pair carries one extra bit.
        let side = match assignment {
            8 | 10 => channel == 1,
            9 => channel == 0,
            _ => false,
        };
        channels.push(subframe(&mut bits, block, depth + u32::from(side))?);
    }
    bits.align();
    bits.read(16)?; // frame CRC-16

    match assignment {
        8 => {
            let (left, side) = channels.split_at_mut(1);
            for (l, s) in left[0].iter().zip(side[0].iter_mut()) {
                *s = l - *s;
            }
        }
        9 => {
            let (side, right) = channels.split_at_mut(1);
            for (s, r) in side[0].iter_mut().zip(right[0].iter()) {
                *s += r;
            }
        }
        10 => {
            let (mid, side) = channels.split_at_mut(1);
            for (m, s) in mid[0].iter_mut().zip(side[0].iter_mut()) {
                let doubled = (*m << 1) | (*s & 1);
                let (left, right) = ((doubled + *s) >> 1, (doubled - *s) >> 1);
                *m = left;
                *s = right;
            }
        }
        _ => {}
    }
    Ok((channels, bits.pos / 8, depth, rate))
}

fn subframe(bits: &mut Bits, block: usize, depth: u32) -> Result<Vec<i32>, String> {
    if bits.read(1)? != 0 {
        return Err("subframe padding bit set".to_string());
    }
    let kind = bits.read(6)? as u32;
    let wasted = if bits.read(1)? == 1 { bits.unary()? + 1 } else { 0 };
    let depth = depth.checked_sub(wasted).ok_or("more wasted bits than bits")?;
    let mut samples: Vec<i32> = match kind {
        0 => vec![bits.signed(depth)? as i32; block],
        1 => (0..block).map(|_| bits.signed(depth).map(|s| s as i32)).collect::<Result<_, _>>()?,
        8..=12 => {
            let order = (kind - 8) as usize;
            let mut samples = warmup(bits, order, depth)?;
            residual(bits, block, order, &mut samples)?;
            const FIXED: [&[i64]; 5] = [&[], &[1], &[2, -1], &[3, -3, 1], &[4, -6, 4, -1]];
            predict(&mut samples, order, FIXED[order], 0);
            samples
        }
        32..=63 => {
            let order = (kind - 31) as usize;
            let mut samples = warmup(bits, order, depth)?;
            let precision = bits.read(4)? as u32 + 1;
            if precision == 16 {
                return Err("invalid LPC precision".to_string());
            }
            let shift = bits.signed(5)?;
            let coefficients: Vec<i64> = (0..order).map(|_| bits.signed(precision)).collect::<Result<_, _>>()?;
            residual(bits, block, order, &mut samples)?;
            predict(&mut samples, order, &coefficients, shift.max(0) as u32);
            samples
        }
        _ => return Err(format!("reserved subframe type {kind}")),
    };
    if wasted > 0 {
        for sample in &mut samples {
            *sample <<= wasted;
        }
    }
    Ok(samples)
}

fn warmup(bits: &mut Bits, order: usize, depth: u32) -> Result<Vec<i32>, String> {
    (0..order).map(|_| bits.signed(depth).map(|s| s as i32)).collect()
}

/// Appends the Rice-coded residual; the prediction is added afterwards.
fn residual(bits: &mut Bits, block: usize, order: usize, samples: &mut Vec<i32>) -> Result<(), String> {
    let parameter_bits = match bits.read(2)? {
        0 => 4,
        1 => 5,
        _ => return Err("reserved residual coding".to_string()),
    };
    let escape = (1u64 << parameter_bits) - 1;
    let partition_order = bits.read(4)? as u32;
    let partitions = 1usize << partition_order;
    for partition in 0..partitions {
        let mut count = block >> partition_order;
        if partition == 0 {
            count = count.checked_sub(order).ok_or("the partition is smaller than the predictor")?;
        }
        let parameter = bits.read(parameter_bits)?;
        if parameter == escape {
            let raw = bits.read(5)? as u32;
            for _ in 0..count {
                samples.push(bits.signed(raw)? as i32);
            }
        } else {
            let parameter = parameter as u32;
            for _ in 0..count {
                let quotient = u64::from(bits.unary()?);
                let value = (quotient << parameter) | bits.read(parameter)?;
                // Zigzag: 0, -1, 1, -2, ...
                samples.push(((value >> 1) as i64 ^ -((value & 1) as i64)) as i32);
            }
        }
    }
    Ok(())
}

fn predict(samples: &mut [i32], order: usize, coefficients: &[i64], shift: u32) {
    for index in order..samples.len() {
        let mut sum = 0i64;
        for (j, coefficient) in coefficients.iter().enumerate() {
            sum += coefficient * i64::from(samples[index - j - 1]);
        }
        samples[index] += (sum >> shift) as i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g711_round_numbers() {
        assert_eq!(ulaw(0xFF), 0);
        assert_eq!(ulaw(0x80), 32124);
        assert_eq!(ulaw(0x00), -32124);
        assert_eq!(alaw(0xD5), 8);
        assert_eq!(alaw(0x55), -8);
    }

    #[test]
    fn formats_are_told_apart_by_their_first_bytes() {
        assert_eq!(sniff(b"fLaC\0\0\0\0"), Some("flac"));
        assert_eq!(sniff(b"FORM\0\0\0\0AIFF"), Some("aiff"));
        assert_eq!(sniff(b".snd"), Some("au"));
        assert!(decode(b"OggS....").unwrap_err().contains("Ogg"));
    }

    fn be32(value: u32) -> [u8; 4] {
        value.to_be_bytes()
    }

    #[test]
    fn au_carries_mulaw_and_linear_pcm() {
        let mut file = b".snd".to_vec();
        for word in [24, 4, 3, 8000, 1] {
            file.extend_from_slice(&be32(word));
        }
        file.extend_from_slice(&[0x40, 0x00, 0xC0, 0x00]);
        let decoded = decode(&file).unwrap();
        assert_eq!(decoded.format, "au");
        assert_eq!(decoded.frame.samples, vec![16384, -16384]);
        assert_eq!(decoded.frame.sample_rate, 8000);
    }

    #[test]
    fn aiff_reads_its_extended_float_rate_and_big_endian_samples() {
        let mut comm = Vec::new();
        comm.extend_from_slice(&1u16.to_be_bytes());
        comm.extend_from_slice(&2u32.to_be_bytes());
        comm.extend_from_slice(&16u16.to_be_bytes());
        // 44100 as an 80-bit extended float.
        comm.extend_from_slice(&[0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
        let mut ssnd = vec![0u8; 8];
        ssnd.extend_from_slice(&[0x12, 0x34, 0xED, 0xCC]);
        let mut body = b"AIFF".to_vec();
        for (id, chunk) in [(b"COMM", &comm), (b"SSND", &ssnd)] {
            body.extend_from_slice(id);
            body.extend_from_slice(&be32(chunk.len() as u32));
            body.extend_from_slice(chunk);
        }
        let mut file = b"FORM".to_vec();
        file.extend_from_slice(&be32(body.len() as u32));
        file.extend_from_slice(&body);
        let decoded = decode(&file).unwrap();
        assert_eq!(decoded.frame.sample_rate, 44100);
        assert_eq!(decoded.frame.samples, vec![0x1234, -0x1234]);
    }

    /// A minimal FLAC stream: STREAMINFO, then one frame of 16 samples whose
    /// subframe is FIXED order 1 with a Rice-coded residual of all +1 steps.
    #[test]
    fn flac_decodes_a_fixed_predictor_frame() {
        let mut file = b"fLaC".to_vec();
        // Last metadata block, STREAMINFO, 34 bytes.
        file.extend_from_slice(&[0x80, 0, 0, 34]);
        let mut info = vec![0u8; 34];
        info[0..2].copy_from_slice(&16u16.to_be_bytes());
        info[2..4].copy_from_slice(&16u16.to_be_bytes());
        // 16000 Hz (20 bits), 1 channel (3 bits: 0), 16 bits (5 bits: 15), 16 samples.
        let packed: u64 = (16000u64 << 44) | (15 << 36) | 16;
        info[10..18].copy_from_slice(&packed.to_be_bytes());
        file.extend_from_slice(&info);

        let mut frame = BitWriter::default();
        frame.write(0b11111111111110, 14);
        frame.write(0, 1); // reserved
        frame.write(0, 1); // fixed blocking
        frame.write(7, 4); // block size: 16 bits follow
        frame.write(0, 4); // sample rate from STREAMINFO
        frame.write(0, 4); // mono
        frame.write(0, 3); // bits from STREAMINFO
        frame.write(0, 1);
        frame.write(0, 8); // frame number 0
        frame.write(15, 16); // block size - 1
        frame.write(0, 8); // CRC-8 (not checked)
        frame.write(0, 1); // subframe padding
        frame.write(9, 6); // FIXED, order 1
        frame.write(0, 1); // no wasted bits
        frame.write(100, 16); // warm-up sample: 100
        frame.write(0, 2); // Rice, 4-bit parameters
        frame.write(0, 4); // partition order 0
        frame.write(1, 4); // parameter 1
        for _ in 0..15 {
            // +1 zigzags to 2: quotient 1 (unary "01"), remainder 0.
            frame.write(0b01, 2);
            frame.write(0, 1);
        }
        frame.align();
        frame.write(0, 16); // CRC-16 (not checked)
        file.extend_from_slice(&frame.bytes);

        let decoded = decode(&file).unwrap();
        assert_eq!(decoded.format, "flac");
        assert_eq!(decoded.frame.sample_rate, 16000);
        assert_eq!(decoded.frame.samples, (100..116).collect::<Vec<i16>>());
    }

    #[derive(Default)]
    struct BitWriter {
        bytes: Vec<u8>,
        used: u32,
    }

    impl BitWriter {
        fn write(&mut self, value: u64, count: u32) {
            for index in (0..count).rev() {
                if self.used % 8 == 0 {
                    self.bytes.push(0);
                }
                let bit = ((value >> index) & 1) as u8;
                let last = self.bytes.len() - 1;
                self.bytes[last] |= bit << (7 - (self.used % 8));
                self.used += 1;
            }
        }

        fn align(&mut self) {
            self.used = self.used.div_ceil(8) * 8;
        }
    }
}
