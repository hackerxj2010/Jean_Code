//! # pi-voice
//!
//! Audio handling for voice mode: WAV encoding and decoding, resampling,
//! silence trimming, and turn detection.
//!
//! **What this crate does not do is talk to an audio device.** Device capture
//! needs CoreAudio, WASAPI, or ALSA, which means platform linkage this crate
//! will not take on. The host supplies PCM frames from wherever it gets them —
//! the CLI's microphone, a Telegram voice note, a browser's `MediaRecorder` —
//! and this crate does everything between that and the speech-to-text request.
//!
//! That split is deliberate rather than a shortcut. The parts worth owning are
//! the ones that are subtly wrong everywhere: resampling that aliases, a WAV
//! header written with the wrong byte count, silence detection that cuts off
//! the end of a sentence. Those are pure computation, testable, and identical
//! on every platform.

pub mod wav;

pub use wav::{decode, encode, Format};

/// A block of PCM audio.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// Interleaved samples, signed 16-bit — what every capture API and every
    /// speech API agrees on.
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl Frame {
    pub fn new(samples: Vec<i16>, sample_rate: u32, channels: u16) -> Self {
        Frame { samples, sample_rate, channels: channels.max(1) }
    }

    pub fn silent(duration_ms: u32, sample_rate: u32) -> Self {
        let count = (sample_rate as u64 * duration_ms as u64 / 1000) as usize;
        Frame { samples: vec![0; count], sample_rate, channels: 1 }
    }

    pub fn duration_ms(&self) -> u64 {
        if self.sample_rate == 0 || self.channels == 0 {
            return 0;
        }
        self.samples.len() as u64 * 1000 / (self.sample_rate as u64 * self.channels as u64)
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Root-mean-square amplitude, 0.0 to 1.0.
    ///
    /// RMS rather than peak: a single click has a high peak and carries no
    /// speech, and trimming on peak leaves every recording padded with noise.
    pub fn rms(&self) -> f32 {
        if self.samples.is_empty() {
            return 0.0;
        }
        // Summed as f64: 16-bit squares overflow an i32 accumulator after about
        // two thousand samples, which is a twentieth of a second.
        let total: f64 = self.samples.iter().map(|s| (*s as f64).powi(2)).sum();
        ((total / self.samples.len() as f64).sqrt() / i16::MAX as f64) as f32
    }

    /// Peak amplitude, 0.0 to 1.0.
    pub fn peak(&self) -> f32 {
        self.samples
            .iter()
            .map(|s| (*s as i32).unsigned_abs() as f32)
            .fold(0.0, f32::max)
            / i16::MAX as f32
    }

    /// Mixes to one channel by averaging.
    ///
    /// Every speech API wants mono, and sending stereo either doubles the cost
    /// or gets silently downmixed by something that may pick one channel — and
    /// picking one channel loses the speaker if they were panned.
    pub fn to_mono(&self) -> Frame {
        if self.channels <= 1 {
            return self.clone();
        }

        let channels = self.channels as usize;
        let samples = self
            .samples
            .chunks(channels)
            .map(|chunk| {
                let sum: i32 = chunk.iter().map(|s| *s as i32).sum();
                (sum / chunk.len() as i32) as i16
            })
            .collect();

        Frame { samples, sample_rate: self.sample_rate, channels: 1 }
    }

    /// Resamples to a new rate with linear interpolation.
    ///
    /// Linear interpolation aliases above about a quarter of the target rate.
    /// For speech resampled to 16 kHz — the rate every transcription model
    /// wants — the energy up there is fricative noise, and the artefact is
    /// inaudible to the model. A proper sinc filter would be better and is not
    /// worth the code here.
    pub fn resample(&self, target_rate: u32) -> Frame {
        if target_rate == 0 || self.sample_rate == 0 || target_rate == self.sample_rate {
            return self.clone();
        }

        let mono = self.to_mono();
        let ratio = mono.sample_rate as f64 / target_rate as f64;
        let count = (mono.samples.len() as f64 / ratio).floor() as usize;
        let mut samples = Vec::with_capacity(count);

        for index in 0..count {
            let position = index as f64 * ratio;
            let left = position.floor() as usize;
            let fraction = position - left as f64;

            let a = *mono.samples.get(left).unwrap_or(&0) as f64;
            let b = *mono.samples.get(left + 1).unwrap_or(&(a as i16)) as f64;

            samples.push((a + (b - a) * fraction).round() as i16);
        }

        Frame { samples, sample_rate: target_rate, channels: 1 }
    }

    /// Removes silence from both ends.
    pub fn trim_silence(&self, threshold: f32, window_ms: u32) -> Frame {
        let window = self.window_samples(window_ms);
        if window == 0 || self.samples.is_empty() {
            return self.clone();
        }

        let loud = |start: usize| -> bool {
            let end = (start + window).min(self.samples.len());
            let slice = Frame {
                samples: self.samples[start..end].to_vec(),
                sample_rate: self.sample_rate,
                channels: self.channels,
            };
            slice.rms() > threshold
        };

        let mut first = 0;
        while first + window <= self.samples.len() && !loud(first) {
            first += window;
        }

        if first + window > self.samples.len() {
            // Nothing above the threshold anywhere.
            return Frame { samples: Vec::new(), sample_rate: self.sample_rate, channels: self.channels };
        }

        let mut last = self.samples.len();
        while last >= window && !loud(last - window) {
            last -= window;
        }

        // A small pad on each side: cutting exactly at the threshold clips the
        // attack of the first word and the release of the last.
        let pad = window;
        let start = first.saturating_sub(pad);
        let end = (last + pad).min(self.samples.len());

        Frame {
            samples: self.samples[start..end.max(start)].to_vec(),
            sample_rate: self.sample_rate,
            channels: self.channels,
        }
    }

    fn window_samples(&self, window_ms: u32) -> usize {
        (self.sample_rate as u64 * window_ms as u64 / 1000) as usize * self.channels.max(1) as usize
    }

    /// Appends another frame, resampling it if needed.
    pub fn append(&mut self, other: &Frame) {
        let matched = if other.sample_rate == self.sample_rate && other.channels == self.channels {
            other.clone()
        } else {
            other.resample(self.sample_rate)
        };
        self.samples.extend_from_slice(&matched.samples);
    }

    /// The frame prepared for a speech-to-text request: mono, 16 kHz, trimmed.
    pub fn for_transcription(&self) -> Frame {
        self.to_mono().resample(16_000).trim_silence(0.01, 30)
    }
}

/// Detects when a speaker has finished, for push-to-talk-free voice mode.
///
/// The hard part is not detecting silence, it is deciding how much silence
/// means "done" rather than "thinking". Too short and the agent interrupts;
/// too long and every exchange feels sluggish. The threshold is a parameter
/// because the right answer depends on the microphone and the room.
#[derive(Debug, Clone)]
pub struct TurnDetector {
    pub threshold: f32,
    /// Silence this long ends the turn.
    pub hangover_ms: u32,
    /// Speech must last this long to count, so a cough is not a turn.
    pub min_speech_ms: u32,
    speech_ms: u32,
    silence_ms: u32,
    started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    /// Nothing yet.
    Waiting,
    /// Speech in progress.
    Speaking,
    /// The speaker finished.
    Ended,
}

impl Default for TurnDetector {
    fn default() -> Self {
        TurnDetector {
            threshold: 0.02,
            // Long enough to survive a pause mid-sentence; short enough not to
            // feel like a delay.
            hangover_ms: 700,
            min_speech_ms: 250,
            speech_ms: 0,
            silence_ms: 0,
            started: false,
        }
    }
}

impl TurnDetector {
    pub fn new(threshold: f32, hangover_ms: u32, min_speech_ms: u32) -> Self {
        TurnDetector { threshold, hangover_ms, min_speech_ms, ..Default::default() }
    }

    /// Feeds a frame and reports the state.
    pub fn push(&mut self, frame: &Frame) -> Turn {
        let duration = frame.duration_ms() as u32;

        if frame.rms() > self.threshold {
            self.speech_ms += duration;
            self.silence_ms = 0;
            if self.speech_ms >= self.min_speech_ms {
                self.started = true;
            }
            return if self.started { Turn::Speaking } else { Turn::Waiting };
        }

        self.silence_ms += duration;

        // Silence before any speech is just waiting, and must not accumulate
        // into a turn that never happened.
        if !self.started {
            self.speech_ms = 0;
            return Turn::Waiting;
        }

        if self.silence_ms >= self.hangover_ms {
            Turn::Ended
        } else {
            Turn::Speaking
        }
    }

    pub fn reset(&mut self) {
        self.speech_ms = 0;
        self.silence_ms = 0;
        self.started = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sine wave, as a stand-in for speech.
    fn tone(duration_ms: u32, sample_rate: u32, amplitude: f32) -> Frame {
        let count = (sample_rate as u64 * duration_ms as u64 / 1000) as usize;
        let samples = (0..count)
            .map(|index| {
                let phase = index as f64 / sample_rate as f64 * 440.0 * std::f64::consts::TAU;
                (phase.sin() * amplitude as f64 * i16::MAX as f64) as i16
            })
            .collect();
        Frame::new(samples, sample_rate, 1)
    }

    #[test]
    fn duration_is_computed_from_the_rate() {
        assert_eq!(Frame::silent(1000, 16_000).duration_ms(), 1000);
        assert_eq!(Frame::new(vec![0; 32_000], 16_000, 2).duration_ms(), 1000);
        // A frame with no rate does not divide by zero.
        assert_eq!(Frame::new(vec![0; 10], 0, 1).duration_ms(), 0);
    }

    #[test]
    fn rms_does_not_overflow_on_a_long_loud_frame() {
        // The bug an i32 accumulator has: two thousand full-scale samples
        // overflow it, and the reported level wraps to something small.
        let loud = Frame::new(vec![i16::MAX; 48_000], 16_000, 1);
        assert!(loud.rms() > 0.99, "{}", loud.rms());
    }

    #[test]
    fn rms_distinguishes_a_click_from_speech() {
        let mut click = vec![0i16; 16_000];
        click[8_000] = i16::MAX;
        let click = Frame::new(click, 16_000, 1);

        let speech = tone(1000, 16_000, 0.3);

        assert!(click.peak() > speech.peak());
        // But RMS, which is what trimming uses, ranks them the other way round.
        assert!(click.rms() < speech.rms());
    }

    #[test]
    fn stereo_mixes_to_mono_by_averaging() {
        let stereo = Frame::new(vec![100, 300, 200, 400], 16_000, 2);
        let mono = stereo.to_mono();
        assert_eq!(mono.channels, 1);
        assert_eq!(mono.samples, vec![200, 300]);
    }

    #[test]
    fn mono_passes_through_unchanged() {
        let mono = tone(100, 16_000, 0.5);
        assert_eq!(mono.to_mono(), mono);
    }

    #[test]
    fn resampling_changes_the_rate_and_keeps_the_duration() {
        let source = tone(1000, 48_000, 0.5);
        let resampled = source.resample(16_000);

        assert_eq!(resampled.sample_rate, 16_000);
        assert_eq!(resampled.samples.len(), 16_000);
        // A one-second recording is still one second.
        assert!((resampled.duration_ms() as i64 - 1000).abs() <= 1);
    }

    #[test]
    fn resampling_upward_also_works() {
        let source = tone(100, 8_000, 0.5);
        let resampled = source.resample(16_000);
        assert_eq!(resampled.samples.len(), 1_600);
    }

    #[test]
    fn resampling_to_the_same_rate_is_a_no_op() {
        let source = tone(100, 16_000, 0.5);
        assert_eq!(source.resample(16_000).samples, source.samples);
    }

    #[test]
    fn resampling_preserves_the_signal_amplitude() {
        // A resampler that halves the level is the classic off-by-one on the
        // interpolation weight.
        let source = tone(500, 48_000, 0.5);
        let resampled = source.resample(16_000);
        assert!((resampled.rms() - source.rms()).abs() < 0.05, "{} vs {}", resampled.rms(), source.rms());
    }

    #[test]
    fn silence_is_trimmed_from_both_ends() {
        let mut frame = Frame::silent(500, 16_000);
        frame.append(&tone(1000, 16_000, 0.5));
        frame.append(&Frame::silent(500, 16_000));

        let trimmed = frame.trim_silence(0.01, 30);
        assert!(trimmed.duration_ms() < frame.duration_ms());
        // The speech itself survives, with a small pad.
        assert!(trimmed.duration_ms() >= 1000, "{}", trimmed.duration_ms());
    }

    #[test]
    fn trimming_pure_silence_yields_nothing() {
        let trimmed = Frame::silent(2000, 16_000).trim_silence(0.01, 30);
        assert!(trimmed.is_empty());
    }

    #[test]
    fn trimming_does_not_clip_speech_that_fills_the_frame() {
        let speech = tone(1000, 16_000, 0.5);
        let trimmed = speech.trim_silence(0.01, 30);
        assert_eq!(trimmed.samples.len(), speech.samples.len());
    }

    #[test]
    fn appending_resamples_a_mismatched_frame() {
        let mut frame = tone(100, 16_000, 0.5);
        let before = frame.samples.len();
        frame.append(&tone(100, 48_000, 0.5));

        // 100 ms at 16 kHz is 1,600 samples, whatever the source rate was.
        assert_eq!(frame.samples.len(), before + 1_600);
        assert_eq!(frame.sample_rate, 16_000);
    }

    #[test]
    fn transcription_preparation_produces_mono_16k() {
        let source = Frame::new(vec![1_000; 96_000], 48_000, 2);
        let prepared = source.for_transcription();
        assert_eq!(prepared.sample_rate, 16_000);
        assert_eq!(prepared.channels, 1);
    }

    #[test]
    fn turn_detection_waits_through_leading_silence() {
        let mut detector = TurnDetector::default();
        for _ in 0..10 {
            assert_eq!(detector.push(&Frame::silent(100, 16_000)), Turn::Waiting);
        }
    }

    #[test]
    fn turn_detection_reports_speech_then_the_end() {
        let mut detector = TurnDetector::default();

        for _ in 0..10 {
            detector.push(&tone(100, 16_000, 0.5));
        }
        assert_eq!(detector.push(&tone(100, 16_000, 0.5)), Turn::Speaking);

        // A short pause mid-sentence must not end the turn.
        assert_eq!(detector.push(&Frame::silent(300, 16_000)), Turn::Speaking);
        assert_eq!(detector.push(&Frame::silent(500, 16_000)), Turn::Ended);
    }

    #[test]
    fn a_cough_is_too_short_to_be_a_turn() {
        let mut detector = TurnDetector::new(0.02, 700, 250);
        assert_eq!(detector.push(&tone(50, 16_000, 0.8)), Turn::Waiting);
        // And the silence after it does not end a turn that never started.
        assert_eq!(detector.push(&Frame::silent(1000, 16_000)), Turn::Waiting);
    }

    #[test]
    fn resetting_clears_the_state() {
        let mut detector = TurnDetector::default();
        for _ in 0..10 {
            detector.push(&tone(100, 16_000, 0.5));
        }
        detector.reset();
        assert_eq!(detector.push(&Frame::silent(1000, 16_000)), Turn::Waiting);
    }
}
