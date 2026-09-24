//! `cksum`, `md5sum`, `sha256sum` (architecture §8.2), implemented from the
//! specifications because this crate takes no dependencies.
//!
//! These are checksums for change detection — "did this file move under me
//! between read and write" — not authentication. MD5 and CRC32 are broken
//! against a deliberate collision and are here for compatibility with tooling
//! that emits them. SHA-256 is the one to use when the answer matters.

// ---- SHA-256 (FIPS 180-4) -------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Streaming SHA-256, so a large file never has to be held in memory.
#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0u8; 64],
            buffered: 0,
            length: 0,
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        let mut offset = 0;

        // Fill a partial buffer first, then run whole blocks straight from the
        // input without copying.
        if self.buffered > 0 {
            let want = 64 - self.buffered;
            let take = want.min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            offset = take;
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }

        while offset + 64 <= data.len() {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[offset..offset + 64]);
            self.compress(&block);
            offset += 64;
        }

        let remaining = data.len() - offset;
        if remaining > 0 {
            self.buffer[..remaining].copy_from_slice(&data[offset..]);
            self.buffered = remaining;
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.length.wrapping_mul(8);

        // Padding: a 1 bit, zeros, then the length as a big-endian u64.
        let mut padding = vec![0x80u8];
        let target = if self.buffered < 56 { 56 } else { 120 };
        padding.resize(target - self.buffered, 0);
        padding.extend_from_slice(&bits.to_be_bytes());

        // The length must not be folded into itself, so bypass `update`.
        let saved = self.length;
        self.update(&padding);
        self.length = saved;

        let mut digest = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for index in 0..16 {
            w[index] = u32::from_be_bytes([
                block[index * 4],
                block[index * 4 + 1],
                block[index * 4 + 2],
                block[index * 4 + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;

        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        for (slot, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
}

/// SHA-256 of a byte slice, hex-encoded.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    to_hex(&hasher.finish())
}

// ---- MD5 (RFC 1321) -------------------------------------------------------

const MD5_SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// The per-round constants, `floor(2^32 * abs(sin(i + 1)))`.
///
/// Computed rather than tabled: a 64-entry table of magic hex is exactly the
/// kind of thing that gets one digit wrong and is never noticed.
fn md5_constants() -> [u32; 64] {
    let mut table = [0u32; 64];
    for (index, slot) in table.iter_mut().enumerate() {
        *slot = (sine(index as f64 + 1.0).abs() * 4_294_967_296.0) as u32;
    }
    table
}

/// `sin` without `std::f64::sin` — available, but a Taylor series keeps this
/// module free of any float-formatting difference across targets.
fn sine(x: f64) -> f64 {
    // Reduce into [-pi, pi] first: the series diverges badly outside it.
    const PI: f64 = std::f64::consts::PI;
    let mut reduced = x % (2.0 * PI);
    if reduced > PI {
        reduced -= 2.0 * PI;
    }
    if reduced < -PI {
        reduced += 2.0 * PI;
    }

    let mut term = reduced;
    let mut sum = reduced;
    for n in 1..20 {
        term *= -reduced * reduced / (((2 * n) * (2 * n + 1)) as f64);
        sum += term;
    }
    sum
}

pub fn md5(data: &[u8]) -> [u8; 16] {
    let constants = md5_constants();
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

    let mut message = data.to_vec();
    let bit_length = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_le_bytes());

    for chunk in message.chunks_exact(64) {
        let mut m = [0u32; 16];
        for index in 0..16 {
            m[index] = u32::from_le_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }

        let [mut a, mut b, mut c, mut d] = state;

        for index in 0..64 {
            let (mixed, position) = match index / 16 {
                0 => ((b & c) | ((!b) & d), index),
                1 => ((d & b) | ((!d) & c), (5 * index + 1) % 16),
                2 => (b ^ c ^ d, (3 * index + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * index) % 16),
            };

            let temp = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(mixed)
                .wrapping_add(constants[index])
                .wrapping_add(m[position]);
            b = b.wrapping_add(sum.rotate_left(MD5_SHIFTS[index]));
            a = temp;
        }

        for (slot, value) in state.iter_mut().zip([a, b, c, d]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut digest = [0u8; 16];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    digest
}

pub fn md5_hex(data: &[u8]) -> String {
    to_hex(&md5(data))
}

// ---- CRC-32 (as `cksum` and zip use it) -----------------------------------

fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 != 0 { 0xedb88320 ^ (value >> 1) } else { value >> 1 };
        }
        *slot = value;
    }
    table
}

pub fn crc32(data: &[u8]) -> u32 {
    let table = crc_table();
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

// ---- FNV-1a, for cheap non-cryptographic keys -----------------------------

/// 64-bit FNV-1a. Used where a hash only needs to distinguish, not to resist:
/// cache keys, dedup sets, bucket assignment.
pub fn fnv1a(data: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

// ---- encoding -------------------------------------------------------------

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    out
}

pub fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("hex string has an odd length".to_string());
    }
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(2)
        .map(|pair| {
            let high = pair[0].to_digit(16).ok_or_else(|| format!("not hex: {}", pair[0]))?;
            let low = pair[1].to_digit(16).ok_or_else(|| format!("not hex: {}", pair[1]))?;
            Ok(((high << 4) | low) as u8)
        })
        .collect()
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { BASE64[((triple >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64[(triple & 0x3f) as usize] as char } else { '=' });
    }
    out
}

pub fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut accumulator = 0u32;
    let mut bits = 0u32;

    for c in text.chars() {
        if c == '=' || c.is_whitespace() {
            continue;
        }
        let value = BASE64
            .iter()
            .position(|b| *b as char == c)
            .ok_or_else(|| format!("not base64: {c}"))? as u32;

        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_published_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn sha256_streams_the_same_as_one_shot() {
        // The 55/56/64-byte boundaries are where padding logic goes wrong.
        for length in [0usize, 1, 55, 56, 63, 64, 65, 119, 120, 1000] {
            let data = vec![0x61u8; length];
            let one_shot = sha256_hex(&data);

            let mut streamed = Sha256::new();
            for chunk in data.chunks(7) {
                streamed.update(chunk);
            }
            assert_eq!(to_hex(&streamed.finish()), one_shot, "length {length}");
        }
    }

    #[test]
    fn md5_matches_rfc_1321() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(b"The quick brown fox jumps over the lazy dog"),
            "9e107d9d372bb6826bd81d3542a419d6"
        );
    }

    #[test]
    fn crc32_matches_the_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn base64_round_trips_every_padding_case() {
        for input in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let encoded = base64_encode(input.as_bytes());
            assert_eq!(base64_decode(&encoded).unwrap(), input.as_bytes(), "{input}");
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"f"), "Zg==");
    }

    #[test]
    fn hex_round_trips_and_rejects_junk() {
        assert_eq!(to_hex(&[0x00, 0xff, 0x1a]), "00ff1a");
        assert_eq!(from_hex("00ff1a").unwrap(), vec![0x00, 0xff, 0x1a]);
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }

    #[test]
    fn fnv_separates_similar_inputs() {
        assert_ne!(fnv1a(b"a"), fnv1a(b"b"));
        assert_ne!(fnv1a(b"ab"), fnv1a(b"ba"));
    }
}
