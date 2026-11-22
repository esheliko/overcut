//! WebCodecs codec strings from codec configuration records. Pure functions on byte slices; short input falls back to a safe default.

use std::fmt::Write;

/// `avc1.PPCCLL` from an `avcC` record.
pub(crate) fn avc(prefix: &str, avcc: &[u8]) -> String {
    match avcc {
        [_, p, c, l, ..] => format!("{prefix}.{p:02x}{c:02x}{l:02x}"),
        _ => prefix.to_string(),
    }
}

/// `hvc1.<space><profile>.<compat reversed>.<tier><level>.<constraints>` from an `hvcC` record.
pub(crate) fn hevc(prefix: &str, hvcc: &[u8]) -> String {
    if hvcc.len() < 13 {
        return prefix.to_string();
    }
    let space = match hvcc[1] >> 6 {
        1 => "A",
        2 => "B",
        3 => "C",
        _ => "",
    };
    let profile = hvcc[1] & 0x1f;
    let tier = if hvcc[1] & 0x20 != 0 { 'H' } else { 'L' };
    let compat = u32::from_be_bytes([hvcc[2], hvcc[3], hvcc[4], hvcc[5]]).reverse_bits();
    let level = hvcc[12];
    let mut constraints = hvcc[6..12].to_vec();
    while constraints.last() == Some(&0) {
        constraints.pop();
    }
    let mut s = format!("{prefix}.{space}{profile}.{compat:X}.{tier}{level}");
    if constraints.is_empty() {
        s.push_str(".0");
    }
    for b in constraints {
        let _ = write!(s, ".{b:X}");
    }
    s
}

/// `vp09.PP.LL.DD` from a `vpcC` record body (after the 4-byte full-box header).
pub(crate) fn vp9(vpcc: &[u8]) -> String {
    match vpcc {
        [profile, level, b, ..] => format!("vp09.{profile:02}.{level:02}.{:02}", b >> 4),
        _ => "vp09.00.10.08".to_string(),
    }
}

/// `av01.P.LLT.DD` from an `av1C` record.
pub(crate) fn av1(av1c: &[u8]) -> String {
    match av1c {
        [_, b1, b2, ..] => {
            let profile = b1 >> 5;
            let level = b1 & 0x1f;
            let tier = if b2 & 0x80 != 0 { 'H' } else { 'M' };
            let depth = match (b2 & 0x40 != 0, b2 & 0x20 != 0) {
                (true, true) => 12,
                (true, false) => 10,
                _ => 8,
            };
            format!("av01.{profile}.{level:02}{tier}.{depth:02}")
        }
        _ => "av01.0.04M.08".to_string(),
    }
}

/// MPEG-4 audio object type from an AudioSpecificConfig.
pub(crate) fn audio_object_type(asc: &[u8]) -> Option<u32> {
    let b0 = *asc.first()?;
    let aot = u32::from(b0 >> 3);
    if aot != 31 {
        return Some(aot);
    }
    let b1 = *asc.get(1)?;
    Some(32 + u32::from(((b0 & 7) << 3) | (b1 >> 5)))
}

/// Codec string for an `esds` object type indication plus its AudioSpecificConfig.
pub(crate) fn mp4a(oti: u8, asc: &[u8]) -> String {
    match oti {
        0x40 => format!("mp4a.40.{}", audio_object_type(asc).unwrap_or(2)),
        0x69 | 0x6B => "mp3".to_string(),
        other => format!("mp4a.{other:02X}"),
    }
}
