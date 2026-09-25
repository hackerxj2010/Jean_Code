//! WAV encoding and decoding.
//!
//! WAV is the format every speech API accepts and every platform can play, and
//! its header is short enough to write correctly by hand. The failure mode
//! worth guarding against is a header whose declared sizes disagree with the
//! actual data — some decoders trust the header and read past the end, others
//! trust the file and ignore the header, and the bug shows up as truncated
//! audio on one platform only.

use crate::Frame;

/// The parts of a WAV header that matter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
}

impl Default for Format {
    fn default() -> Self {
        // 16 kHz mono 16-bit: what every transcription model wants, and the
        // smallest thing that does not lose speech.
        Format { channels: 1, sample_rate: 16_000, bits_per_sample: 16 }
    }
}

/// Encodes a frame as a 16-bit PCM WAV file.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let channels = frame.channels.max(1);
    let bytes_per_sample = 2u32;
    let data_length = frame.samples.len() as u32 * bytes_per_sample;

    let mut out = Vec::with_capacity(44 + data_length as usize);

    out.extend_from_slice(b"RIFF");
    // Everything after this field: 36 bytes of header plus the data.
    out.extend_from_slice(&(36 + data_length).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&frame.sample_rate.to_le_bytes());

    let byte_rate = frame.sample_rate * channels as u32 * bytes_per_sample;
    out.extend_from_slice(&byte_rate.to_le_bytes());

    let block_align = channels * bytes_per_sample as u16;
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_length.to_le_bytes());

    for sample in &frame.samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }

    out
}

/// Decodes a PCM WAV file.
pub fn decode(bytes: &[u8]) -> Result<Frame, String> {
    if bytes.len() < 12 {
        return Err("too short to be a WAV file".to_string());
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }

    let mut format: Option<Format> = None;
    let mut encoding = 1u16;
    let mut data: Option<&[u8]> = None;
    let mut offset = 12;

    // Chunks are walked rather than assumed to be in order: real files carry
    // `LIST` and `fact` chunks before `data`, and a decoder that assumes the
    // header is exactly 44 bytes reads metadata as audio.
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;

        let body_start = offset + 8;
        // A declared size past the end of the file is the corruption this
        // guards: clamp rather than panic, and decode what is actually there.
        let body_end = (body_start + size).min(bytes.len());

        match id {
            b"fmt " => {
                if body_end - body_start < 16 {
                    return Err("the fmt chunk is too short".to_string());
                }
                let body = &bytes[body_start..body_end];
                encoding = u16::from_le_bytes([body[0], body[1]]);
                // WAVE_FORMAT_EXTENSIBLE carries the real format in its
                // sub-format GUID, whose first two bytes are the code.
                if encoding == 0xFFFE && body.len() >= 26 {
                    encoding = u16::from_le_bytes([body[24], body[25]]);
                }
                if !matches!(encoding, 1 | 3 | 6 | 7) {
                    return Err(format!(
                        "unsupported WAV encoding {encoding}: PCM, float, A-law, and μ-law are read"
                    ));
                }
                format = Some(Format {
                    channels: u16::from_le_bytes([body[2], body[3]]).max(1),
                    sample_rate: u32::from_le_bytes([body[4], body[5], body[6], body[7]]),
                    bits_per_sample: u16::from_le_bytes([body[14], body[15]]),
                });
            }
            b"data" => data = Some(&bytes[body_start..body_end]),
            _ => {}
        }

        // Chunks are word-aligned: an odd size is followed by a pad byte, and
        // ignoring it desynchronises every chunk after it.
        offset = body_start + size + (size % 2);
    }

    let format = format.ok_or("no fmt chunk")?;
    let data = data.ok_or("no data chunk")?;

    let to_i16 = |value: f64| (value.clamp(-1.0, 1.0) * 32767.0).round() as i16;
    let samples = match (encoding, format.bits_per_sample) {
        (7, _) => data.iter().map(|byte| crate::codecs::ulaw(*byte)).collect(),
        (6, _) => data.iter().map(|byte| crate::codecs::alaw(*byte)).collect(),
        (3, 32) => data.chunks_exact(4).map(|q| to_i16(f64::from(f32::from_le_bytes([q[0], q[1], q[2], q[3]])))).collect(),
        (3, 64) => data.chunks_exact(8).map(|o| to_i16(f64::from_le_bytes(o.try_into().unwrap_or([0; 8])))).collect(),
        (3, other) => return Err(format!("unsupported float depth: {other}")),
        (_, 16) => data
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect(),
        // 8-bit WAV is unsigned with a 128 offset, which is the detail that
        // makes a naive conversion sound like loud static.
        (_, 8) => data.iter().map(|byte| ((*byte as i16) - 128) * 256).collect(),
        (_, 24) => data
            .chunks_exact(3)
            .map(|triple| i16::from_le_bytes([triple[1], triple[2]]))
            .collect(),
        (_, 32) => data
            .chunks_exact(4)
            .map(|quad| i16::from_le_bytes([quad[2], quad[3]]))
            .collect(),
        (_, other) => return Err(format!("unsupported bit depth: {other}")),
    };

    Ok(Frame { samples, sample_rate: format.sample_rate.max(1), channels: format.channels })
}

/// Reads the format without decoding the audio.
pub fn probe(bytes: &[u8]) -> Result<Format, String> {
    if bytes.len() < 36 || &bytes[0..4] != b"RIFF" {
        return Err("not a WAV file".to_string());
    }
    Ok(Format {
        channels: u16::from_le_bytes([bytes[22], bytes[23]]).max(1),
        sample_rate: u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
        bits_per_sample: u16::from_le_bytes([bytes[34], bytes[35]]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Frame {
        Frame::new(vec![0, 1_000, -1_000, i16::MAX, i16::MIN], 16_000, 1)
    }

    #[test]
    fn round_trips() {
        let original = frame();
        let decoded = decode(&encode(&original)).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn the_header_is_the_documented_size() {
        let bytes = encode(&frame());
        assert_eq!(bytes.len(), 44 + 5 * 2);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
    }

    #[test]
    fn the_declared_sizes_match_the_data() {
        // The bug this catches: a header claiming more bytes than the file has,
        // which some decoders read past and others truncate.
        let bytes = encode(&frame());
        let riff_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        assert_eq!(riff_size as usize, bytes.len() - 8);

        let data_size = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]);
        assert_eq!(data_size as usize, bytes.len() - 44);
    }

    #[test]
    fn stereo_round_trips_with_its_channel_count() {
        let stereo = Frame::new(vec![1, 2, 3, 4], 48_000, 2);
        let decoded = decode(&encode(&stereo)).unwrap();
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.samples, vec![1, 2, 3, 4]);
    }

    #[test]
    fn probing_reads_the_format_without_the_audio() {
        let bytes = encode(&Frame::new(vec![0; 1_000], 44_100, 2));
        let format = probe(&bytes).unwrap();
        assert_eq!(format.sample_rate, 44_100);
        assert_eq!(format.channels, 2);
        assert_eq!(format.bits_per_sample, 16);
    }

    #[test]
    fn extra_chunks_before_data_are_skipped() {
        // Real recorders write LIST chunks; assuming a 44-byte header decodes
        // the metadata as audio.
        let mut bytes = encode(&frame());
        let mut with_list = bytes[..36].to_vec();
        with_list.extend_from_slice(b"LIST");
        with_list.extend_from_slice(&8u32.to_le_bytes());
        with_list.extend_from_slice(b"INFOxxxx");
        with_list.extend_from_slice(&bytes[36..]);

        // Fix the RIFF size so the file is well-formed.
        let size = (with_list.len() - 8) as u32;
        with_list[4..8].copy_from_slice(&size.to_le_bytes());
        bytes = with_list;

        assert_eq!(decode(&bytes).unwrap().samples, frame().samples);
    }

    #[test]
    fn an_odd_sized_chunk_is_padded() {
        let mut bytes = encode(&frame());
        let mut with_odd = bytes[..36].to_vec();
        with_odd.extend_from_slice(b"note");
        with_odd.extend_from_slice(&3u32.to_le_bytes());
        with_odd.extend_from_slice(b"abc");
        with_odd.push(0); // the pad byte
        with_odd.extend_from_slice(&bytes[36..]);

        let size = (with_odd.len() - 8) as u32;
        with_odd[4..8].copy_from_slice(&size.to_le_bytes());
        bytes = with_odd;

        assert_eq!(decode(&bytes).unwrap().samples, frame().samples);
    }

    #[test]
    fn a_truncated_file_decodes_what_is_there() {
        let bytes = encode(&frame());
        let truncated = &bytes[..bytes.len() - 4];
        let decoded = decode(truncated).unwrap();
        assert_eq!(decoded.samples.len(), 3);
    }

    #[test]
    fn eight_bit_audio_is_offset_corrected() {
        // 8-bit WAV is unsigned around 128; reading it as signed is static.
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36u32 + 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&[128, 255]);

        let decoded = decode(&bytes).unwrap();
        // Silence is 128, which must decode to zero.
        assert_eq!(decoded.samples[0], 0);
        assert!(decoded.samples[1] > 30_000);
    }

    #[test]
    fn a_non_wav_file_is_rejected_with_a_reason() {
        assert!(decode(b"not audio at all").is_err());
        assert!(decode(&[]).is_err());
        assert!(decode(b"RIFF____WAVE").unwrap_err().contains("fmt"));
    }

    #[test]
    fn a_compressed_wav_is_refused_rather_than_decoded_as_noise() {
        let mut bytes = encode(&frame());
        // Format 2 is ADPCM.
        bytes[20..22].copy_from_slice(&2u16.to_le_bytes());
        assert!(decode(&bytes).unwrap_err().contains("PCM"));
    }

    #[test]
    fn an_empty_frame_encodes_to_a_valid_header() {
        let empty = Frame::new(Vec::new(), 16_000, 1);
        let bytes = encode(&empty);
        assert_eq!(bytes.len(), 44);
        assert!(decode(&bytes).unwrap().is_empty());
    }
}
