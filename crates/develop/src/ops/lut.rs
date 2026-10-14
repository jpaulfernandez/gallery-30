//! The look's 3D LUT (workflow plan 18) as a pipeline pass: applied to the display-referred, transfer-encoded output
//! values (sRGB transfer, in the output's primaries) after the tone curves and before colour grading, inside
//! [`crate::ops::output::encode_row_with`], so masked rows get it too. `strength` (0..100) blends the LUT's output
//! with its input; the result is clamped to 0..1.
//!
//! The LUT comes from [`crate::lut::get`] by id. A missing file skips the pass ([`LutParams::new`] is `None`, logged
//! once per id); the develop hash still names the id, so the editor reports it ([`missing_lut`]).

use std::sync::{Arc, Mutex};

use crate::lut::{self, Lut3d};
use crate::settings::{DevelopSettings, Look, LutRef};

#[derive(Debug, Clone)]
pub struct LutParams {
    pub lut: Arc<Lut3d>,
    /// 0..1.
    pub strength: f32,
}

impl LutParams {
    /// `None` without a LUT, at strength 0, or when the LUT's file is missing.
    pub fn new(look: &Look) -> Option<Self> {
        let r = look.lut.as_ref()?;
        let strength = (r.strength.clamp(0.0, 100.0) / 100.0) as f32;
        if strength <= 0.0 {
            return None;
        }
        match lut::get(&r.id) {
            Some(lut) => Some(Self { lut, strength }),
            None => {
                warn_missing(r);
                None
            }
        }
    }

    /// One encoded triple through the LUT, blended by strength. The GPU (`lut_apply` in chain.wgsl) matches it.
    #[inline]
    pub fn apply(&self, enc: [f32; 3]) -> [f32; 3] {
        let out = self.lut.apply(enc);
        std::array::from_fn(|c| (enc[c] + self.strength * (out[c] - enc[c])).clamp(0.0, 1.0))
    }
}

/// The look's LUT when it is set but its file cannot be found (the render skips it and should say so).
pub fn missing_lut(settings: &DevelopSettings) -> Option<&LutRef> {
    settings.look.lut.as_ref().filter(|r| !lut::present(&r.id))
}

/// Log a missing LUT once per id (renders run per slider tick).
fn warn_missing(r: &LutRef) {
    static WARNED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
    if !warned.contains(&r.id) {
        log::warn!("[photobook:develop] LUT missing: {} ({}); rendering without it", r.name, r.id);
        warned.push(r.id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strength_blends_and_zero_is_off() {
        lut::insert("ops-lut-test", Arc::new(invert()));
        let look = |strength| Look { lut: Some(LutRef { id: "ops-lut-test".into(), name: "Invert".into(), strength }) };
        assert!(LutParams::new(&look(0.0)).is_none());
        assert!(LutParams::new(&Look::default()).is_none());
        let half = LutParams::new(&look(50.0)).unwrap();
        let out = half.apply([0.2, 0.6, 1.0]);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6), "{out:?}");
        let full = LutParams::new(&look(100.0)).unwrap();
        assert!((full.apply([0.25, 0.5, 0.75])[0] - 0.75).abs() < 1e-6);
        let missing = Look { lut: Some(LutRef { id: "0".repeat(64), name: "Gone".into(), strength: 100.0 }) };
        assert!(LutParams::new(&missing).is_none());
    }

    fn invert() -> Lut3d {
        let mut l = Lut3d::identity(2);
        for v in &mut l.data {
            *v = v.map(|c| 1.0 - c);
        }
        l
    }
}
