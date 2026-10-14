//! Just enough JPEG marker parsing to read and write the APP1 (Exif) and APP2 (ICC) segments that
//! libjpeg-turbo's simple API neither exposes nor writes.

const SOI: [u8; 2] = [0xFF, 0xD8];
const APP1: u8 = 0xE1;
const APP2: u8 = 0xE2;
const ICC_SIG: &[u8] = b"ICC_PROFILE\0";
const EXIF_SIG: &[u8] = b"Exif\0\0";
/// Largest segment payload (the 2-byte length field counts itself).
const MAX_PAYLOAD: usize = 65533;

/// One marker segment before the scan data: `marker` (the byte after 0xFF), the offset of its 0xFF and
/// the payload after the length field.
struct Segment<'a> {
    marker: u8,
    start: usize,
    payload: &'a [u8],
}

/// Marker segments from SOI up to (not including) the first SOS. Stops quietly at anything malformed.
fn segments(bytes: &[u8]) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    if !bytes.starts_with(&SOI) {
        return out;
    }
    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            break;
        }
        let marker = bytes[pos + 1];
        if marker == 0xFF {
            pos += 1; // fill byte
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // SOS or EOI: no more headers
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > bytes.len() {
            break;
        }
        out.push(Segment { marker, start: pos, payload: &bytes[pos + 4..pos + 2 + len] });
        pos += 2 + len;
    }
    out
}

/// The embedded ICC profile (APP2 `ICC_PROFILE` chunks reassembled in sequence order), if complete.
pub fn read_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut chunks: Vec<(u8, u8, &[u8])> = segments(bytes)
        .into_iter()
        .filter(|s| s.marker == APP2 && s.payload.len() > ICC_SIG.len() + 2 && s.payload.starts_with(ICC_SIG))
        .map(|s| (s.payload[ICC_SIG.len()], s.payload[ICC_SIG.len() + 1], &s.payload[ICC_SIG.len() + 2..]))
        .collect();
    if chunks.is_empty() {
        return None;
    }
    chunks.sort_by_key(|c| c.0);
    let count = chunks[0].1 as usize;
    if chunks.len() != count || chunks.iter().enumerate().any(|(i, c)| c.0 as usize != i + 1) {
        return None;
    }
    Some(chunks.into_iter().flat_map(|c| c.2.iter().copied()).collect())
}

/// The payload of the first APP1 Exif segment (starting with `Exif\0\0`).
pub fn read_exif(bytes: &[u8]) -> Option<Vec<u8>> {
    segments(bytes).into_iter().find(|s| s.marker == APP1 && s.payload.starts_with(EXIF_SIG)).map(|s| s.payload.to_vec())
}

/// Insert a marker segment after SOI and after any APPn segments numbered below `marker`, so APP0
/// (JFIF), APP1 (Exif) and APP2 (ICC) end up in the conventional order.
pub fn insert_segment(jpeg: &mut Vec<u8>, marker: u8, payload: &[u8]) -> bool {
    if !jpeg.starts_with(&SOI) || payload.len() > MAX_PAYLOAD {
        return false;
    }
    let at = segments(jpeg)
        .into_iter()
        .take_while(|s| (0xE0..marker).contains(&s.marker))
        .last()
        .map(|s| s.start + 4 + s.payload.len())
        .unwrap_or(2);
    let mut seg = Vec::with_capacity(payload.len() + 4);
    seg.extend_from_slice(&[0xFF, marker]);
    seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    seg.extend_from_slice(payload);
    jpeg.splice(at..at, seg);
    true
}

/// Embed an ICC profile as APP2 `ICC_PROFILE` chunks.
pub fn insert_icc(jpeg: &mut Vec<u8>, profile: &[u8]) -> bool {
    let per = MAX_PAYLOAD - ICC_SIG.len() - 2;
    let chunks: Vec<&[u8]> = profile.chunks(per).collect();
    if chunks.is_empty() || chunks.len() > 255 {
        return false;
    }
    // Insert in reverse so each lands before the previous one, ending in sequence order.
    for (i, chunk) in chunks.iter().enumerate().rev() {
        let mut payload = Vec::with_capacity(chunk.len() + ICC_SIG.len() + 2);
        payload.extend_from_slice(ICC_SIG);
        payload.push(i as u8 + 1);
        payload.push(chunks.len() as u8);
        payload.extend_from_slice(chunk);
        if !insert_segment(jpeg, APP2, &payload) {
            return false;
        }
    }
    true
}

/// Insert an Exif APP1 payload (starting with `Exif\0\0`).
pub fn insert_exif(jpeg: &mut Vec<u8>, payload: &[u8]) -> bool {
    payload.starts_with(EXIF_SIG) && insert_segment(jpeg, APP1, payload)
}

/// Set the IFD0 Orientation tag (0x0112) of an Exif APP1 payload to 1 (upright), in place. Returns
/// whether the tag was found and rewritten.
pub fn reset_orientation(exif: &mut [u8]) -> bool {
    let tiff_start = EXIF_SIG.len();
    let Some(tiff) = exif.get_mut(tiff_start..) else { return false };
    if tiff.len() < 8 {
        return false;
    }
    let le = match &tiff[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let u16_at = |t: &[u8], o: usize| -> Option<u16> {
        let b = t.get(o..o + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let u32_at = |t: &[u8], o: usize| -> Option<u32> {
        let b = t.get(o..o + 4)?;
        let arr = [b[0], b[1], b[2], b[3]];
        Some(if le { u32::from_le_bytes(arr) } else { u32::from_be_bytes(arr) })
    };
    let Some(ifd0) = u32_at(tiff, 4).map(|v| v as usize) else { return false };
    let Some(count) = u16_at(tiff, ifd0) else { return false };
    for i in 0..count as usize {
        let entry = ifd0 + 2 + i * 12;
        let (Some(tag), Some(kind)) = (u16_at(tiff, entry), u16_at(tiff, entry + 2)) else { return false };
        if tag == 0x0112 && kind == 3 {
            let value = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            match tiff.get_mut(entry + 8..entry + 10) {
                Some(slot) => {
                    slot.copy_from_slice(&value);
                    return true;
                }
                None => return false,
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_jpeg() -> Vec<u8> {
        // SOI, APP0 (JFIF stub), SOS stub, EOI. Only the header walk matters here.
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x07, b'J', b'F', b'I', b'F', 0x00];
        j.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        j
    }

    #[test]
    fn icc_round_trip_and_order() {
        let mut j = minimal_jpeg();
        let profile: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
        assert!(insert_icc(&mut j, &profile));
        let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec();
        assert!(reset_orientation(&mut exif));
        assert_eq!(&exif[6 + 8 + 2 + 8..6 + 8 + 2 + 10], &[0, 1]);
        assert!(insert_exif(&mut j, &exif));
        assert_eq!(read_icc(&j).unwrap(), profile);
        assert_eq!(read_exif(&j).unwrap(), exif);
        let markers: Vec<u8> = segments(&j).iter().map(|s| s.marker).collect();
        assert_eq!(markers, vec![0xE0, 0xE1, 0xE2, 0xE2, 0xE2]);
    }
}
