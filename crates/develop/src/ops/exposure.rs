//! Exposure: `rgb *= 2^EV`.

/// The gain for an exposure in EV, or `None` at 0.
pub fn exposure_gain(ev: f64) -> Option<f32> {
    (ev != 0.0).then(|| 2f64.powf(ev) as f32)
}

pub fn exposure(row: &mut [f32], gain: f32) {
    for v in row {
        *v *= gain;
    }
}
