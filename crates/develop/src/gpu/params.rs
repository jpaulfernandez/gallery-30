//! The chain kernel's inputs, built from the CPU's [`Params`] so both paths read the same numbers: the
//! uniform block (`Chain` in chain.wgsl), the lookup tables (highlights/shadows gain, the colour mix's
//! hue bins) and the curves texture data.

use crate::color::matrix::{self, Mat3, Mat3f};
use crate::color::oklab::{M1, M2};
use crate::cpu::{LocalBlend, Params};
use crate::ops::color::BINS;
use crate::ops::tonal::GAIN_LUT_SIZE;

pub(crate) const PASS_WB: u32 = 1;
pub(crate) const PASS_EXPOSURE: u32 = 2;
pub(crate) const PASS_HS: u32 = 4;
pub(crate) const PASS_WHITES_BLACKS: u32 = 8;
pub(crate) const PASS_CONTRAST: u32 = 16;
pub(crate) const PASS_CLARITY: u32 = 32;
pub(crate) const PASS_TEXTURE: u32 = 64;
pub(crate) const PASS_DEHAZE: u32 = 128;
pub(crate) const PASS_SHARPEN: u32 = 256;
pub(crate) const PASS_COLOR: u32 = 512;
pub(crate) const PASS_LOOK: u32 = 1024;
pub(crate) const PASS_CURVES: u32 = 2048;
/// The look's 3D LUT (workflow plan 18).
pub(crate) const PASS_LUT: u32 = 4096;
/// Effects (workflow plans 17 and 19): halation and vignette in linear light, grading and grain on the output.
pub(crate) const PASS_HALATION: u32 = 8192;
pub(crate) const PASS_VIGNETTE: u32 = 16384;
pub(crate) const PASS_GRADING: u32 = 32768;
pub(crate) const PASS_GRAIN: u32 = 65536;

/// A 3×3 matrix as three `vec4` rows.
pub(crate) type Rows = [[f32; 4]; 3];

fn rows(m: &Mat3f) -> Rows {
    m.map(|r| [r[0], r[1], r[2], 0.0])
}

/// `Chain` in chain.wgsl (every member 16-byte aligned, so `repr(C)` matches the WGSL layout).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct ChainUniform {
    pub flags: [u32; 4],
    pub origin: [i32; 4],
    pub size: [u32; 4],
    pub wb: Rows,
    pub tone: [f32; 4],
    pub wb_curve: [f32; 4],
    pub detail: [f32; 4],
    pub air_measured: [f32; 4],
    pub air: [f32; 4],
    pub sharpen: [f32; 4],
    pub color: [f32; 4],
    pub hs: [f32; 4],
    pub clarity: [f32; 4],
    pub haze: [f32; 4],
    pub work_to_lms: Rows,
    pub work_from_lms: Rows,
    pub out_to_lms: Rows,
    pub out_from_lms: Rows,
    pub m2: Rows,
    pub m2_inv: Rows,
    pub to_srgb: Rows,
    /// Masks: layer count, `LOCAL_*` bits, white balance table size (temperature, tint).
    pub masks: [u32; 4],
    /// Global values the local ones add to: exposure EV, exposure gain, grey gain, base scale.
    pub local_a: [f32; 4],
    /// Highlights, shadows, whites, blacks (unit).
    pub local_b: [f32; 4],
    /// Contrast, clarity, texture, dehaze (unit).
    pub local_c: [f32; 4],
    /// Saturation (unit), sharpening amount (unit), detail, masking.
    pub local_d: [f32; 4],
    /// White balance table: temperature start and step, tint start and step.
    pub wb_lut: [f32; 4],
    /// x: offset of the white balance table in `luts`.
    pub lut_offsets: [u32; 4],
    /// The 3D LUT (plan 18): size − 1, strength (0..1).
    pub lut3d: [f32; 4],
    /// The 3D LUT's `DOMAIN_MIN` (xyz).
    pub lut3d_min: [f32; 4],
    /// `1 / (DOMAIN_MAX − DOMAIN_MIN)` (xyz).
    pub lut3d_scale: [f32; 4],
    /// Halation (plan 19): the glow plane's low w, low h, 1 / factor (as [`coarse`]), and gain × grey gain.
    pub halation: [f32; 4],
    /// Vignette: signed stops, falloff middle, falloff width, superellipse exponent.
    pub vignette: [f32; 4],
    /// Vignette frame: w, h and the axis scales.
    pub vignette_frame: [f32; 4],
    /// Grading: the Oklab `(a, b)` offsets of the shadows and midtones wheels.
    pub grading_a: [f32; 4],
    /// Grading: the highlights wheel's offset, the pivot and the band edge width.
    pub grading_b: [f32; 4],
    /// Grading (plan 55): the Global wheel's offset, 1 when the luminance offsets or the Global wheel are on, 0.
    pub grading_c: [f32; 4],
    /// Grading (plan 55): the `L` offsets of the shadows, midtones, highlights and Global wheels.
    pub grading_l: [f32; 4],
    /// Grain: amplitude, 1 / cell size, roughness, normalisation.
    pub grain: [f32; 4],
    /// Grain: reference px per pixel.
    pub grain_scale: [f32; 4],
}

/// The `f32` matrices of `color::oklab::Oklab::for_space` (linear RGB → LMS with rows renormalised so
/// white maps to LMS (1, 1, 1), its inverse, M2 and M2⁻¹); the unit test checks them against `Oklab`.
pub(crate) fn oklab_matrices(rgb_to_xyz: &Mat3) -> [Mat3f; 4] {
    let mut to_lms = matrix::mul(&M1, rgb_to_xyz);
    for row in &mut to_lms {
        let sum: f64 = row.iter().sum();
        for v in row.iter_mut() {
            *v /= sum;
        }
    }
    [matrix::to_f32(&to_lms), matrix::to_f32(&matrix::inv(&to_lms)), matrix::to_f32(&M2), matrix::to_f32(&matrix::inv(&M2))]
}

/// A guided filter's coarse plane for the chain: (low w, low h, 1 / factor, _).
pub(crate) fn coarse(lw: u32, lh: u32, factor: u32) -> [f32; 4] {
    [lw as f32, lh as f32, 1.0 / factor.max(1) as f32, 0.0]
}

/// Everything the chain reads that depends only on the settings (the per-tile origin, sizes and the
/// coarse planes' sizes are filled in by the engine).
pub(crate) struct ChainInputs {
    pub uniform: ChainUniform,
    /// `GAIN_LUT_SIZE` gains, then `BINS` × (cos, sin, sat, lum, skin).
    pub luts: Vec<f32>,
    /// `LUT_SIZE` × (r, g, b, 0) when the curves are on.
    pub curves: Option<Vec<[f32; 4]>>,
    /// The look's 3D LUT when it runs (uploaded as a `size³` `rgba32float` 3D texture).
    pub lut3d: Option<std::sync::Arc<crate::lut::Lut3d>>,
}

/// One mask's adjustments as the chain reads them (`mask_adj`, four `vec4` per layer): exposure, contrast,
/// highlights, shadows | whites, blacks, temperature, tint | texture, clarity, dehaze, saturation | sharpness,
/// noise, hue, 0.
pub(crate) fn mask_adjustments(blend: &LocalBlend) -> Vec<[f32; 16]> {
    blend
        .adjustments
        .iter()
        .map(|a| {
            [
                a.exposure, a.contrast, a.highlights, a.shadows, a.whites, a.blacks, a.temperature, a.tint, a.texture,
                a.clarity, a.dehaze, a.saturation, a.sharpness, a.noise, a.hue, 0.0,
            ]
            .map(|v| v as f32)
        })
        .collect()
}

impl ChainInputs {
    /// Add the Effects passes (workflow plan 19) of a `w × h` render (the input's size: the vignette's frame and the
    /// grain's scale depend on it). Halation's plane size is filled in by the engine, which clears its flag when it
    /// has no plane.
    pub fn add_effects(&mut self, params: &Params, (w, h): (u32, u32)) {
        let Some(fx) = &params.effects else { return };
        let u = &mut self.uniform;
        if let Some(p) = &fx.halation {
            u.flags[0] |= PASS_HALATION;
            u.halation[3] = p.gain * p.grey;
        }
        if let Some(p) = &fx.vignette {
            u.flags[0] |= PASS_VIGNETTE;
            let f = p.frame(w, h);
            u.vignette = [p.ev, p.mid, p.width, f.exponent];
            u.vignette_frame = [f.w, f.h, f.sx, f.sy];
        }
        if let Some(p) = &fx.grading {
            u.flags[0] |= PASS_GRADING;
            let o = &p.offsets;
            u.grading_a = [o[0][0], o[0][1], o[1][0], o[1][1]];
            u.grading_b = [o[2][0], o[2][1], p.pivot, p.width];
            if let Some(x) = &p.extra {
                u.grading_c = [x.global[0], x.global[1], 1.0, 0.0];
                u.grading_l = x.luminance;
            }
        }
        if let Some(p) = &fx.grain {
            u.flags[0] |= PASS_GRAIN;
            u.grain = [p.amplitude, p.freq, p.rough, p.norm];
            u.grain_scale = [crate::ops::grain::GrainParams::scale_for(w, h), 0.0, 0.0, 0.0];
        }
    }

    /// Add a render's masks: the global values the local ones add to, the white balance table (appended to
    /// `luts`), the colour bins and atmospheric light when only a mask uses them. `airlight` as in
    /// [`ChainInputs::new`].
    pub fn add_masks(&mut self, params: &Params, blend: &LocalBlend, airlight: Option<[f32; 3]>) {
        let u = &mut self.uniform;
        let s = &params.sliders;
        u.masks = [blend.len() as u32, blend.active, 0, 0];
        u.local_a = [s.exposure_ev, s.exposure_gain, s.grey_gain, s.base_scale];
        u.local_b = [s.highlights, s.shadows, s.whites, s.blacks];
        u.local_c = [s.contrast, s.clarity, s.texture, s.dehaze];
        u.local_d = [s.saturation, s.sharpen_amount, s.sharpen_detail, s.sharpen_masking];
        if let Some(lut) = &blend.wb {
            u.masks[2] = lut.nt as u32;
            u.masks[3] = lut.ni as u32;
            u.wb_lut = [lut.t0, lut.t_step, lut.i0, lut.i_step];
            u.lut_offsets[0] = self.luts.len() as u32;
            self.luts.extend_from_slice(&lut.entries);
        }
        if u.flags[0] & PASS_COLOR == 0 {
            if let Some(c) = &blend.color {
                u.color = [c.vibrance, c.saturation, 0.0, 0.0];
                for (i, e) in c.bins.iter().enumerate() {
                    let o = GAIN_LUT_SIZE + i * 5;
                    self.luts[o..o + 5].copy_from_slice(&[e.cos, e.sin, e.sat, e.lum, e.skin]);
                }
            }
        }
        if let (true, Some(measured)) = (u.flags[0] & PASS_DEHAZE == 0, airlight) {
            u.air_measured = [measured[0], measured[1], measured[2], 0.0];
            let a = params.current_airlight(measured);
            u.air = [a[0], a[1], a[2], 0.0];
        }
    }

    /// `airlight` is the dehaze atmospheric light measured on this image, when dehaze runs.
    pub fn new(params: &Params, airlight: Option<[f32; 3]>) -> ChainInputs {
        let mut u = ChainUniform::default();
        let mut flags = 0;
        if let Some(wb) = &params.white_balance {
            flags |= PASS_WB;
            u.wb = rows(&wb.matrix);
        }
        u.tone[0] = 1.0;
        if let Some(gain) = params.exposure {
            flags |= PASS_EXPOSURE;
            u.tone[0] = gain;
        }
        let mut luts = vec![0.0f32; GAIN_LUT_SIZE + BINS * 5];
        if let Some(hs) = &params.highlights_shadows {
            flags |= PASS_HS;
            u.tone[1] = hs.base_scale;
            luts[..GAIN_LUT_SIZE].copy_from_slice(&hs.lut);
        }
        if let Some(wb) = &params.whites_blacks {
            flags |= PASS_WHITES_BLACKS;
            u.wb_curve = [wb.black, wb.slope, wb.radius, wb.qscale];
            u.detail[0] = wb.white_k;
        }
        if let Some(c) = &params.contrast {
            flags |= PASS_CONTRAST;
            u.tone[2] = c.c;
        }
        if let Some(d) = &params.detail {
            if let Some(c) = &d.clarity {
                flags |= PASS_CLARITY;
                u.detail[1] = c.k;
            }
            if let Some(t) = &d.texture {
                flags |= PASS_TEXTURE;
                u.detail[2] = t.k;
            }
            if let (Some(h), Some(measured)) = (&d.dehaze, airlight) {
                flags |= PASS_DEHAZE;
                u.detail[3] = h.strength;
                u.air_measured = [measured[0], measured[1], measured[2], 0.0];
                let a = params.current_airlight(measured);
                u.air = [a[0], a[1], a[2], 0.0];
            }
            if let Some(s) = &d.sharpen {
                flags |= PASS_SHARPEN;
                u.sharpen = [s.amount, s.detail, s.masking, 0.0];
            }
        }
        if let Some(c) = &params.color {
            flags |= PASS_COLOR;
            u.color = [c.vibrance, c.saturation, 0.0, 0.0];
            for (i, e) in c.bins.iter().enumerate() {
                let o = GAIN_LUT_SIZE + i * 5;
                luts[o..o + 5].copy_from_slice(&[e.cos, e.sin, e.sat, e.lum, e.skin]);
            }
        }
        if params.look {
            flags |= PASS_LOOK;
        }
        let curves = params.output.curves.as_ref().map(|c| {
            let [r, g, b] = &c.luts;
            r.values().iter().zip(g.values()).zip(b.values()).map(|((r, g), b)| [*r, *g, *b, 0.0]).collect()
        });
        if curves.is_some() {
            flags |= PASS_CURVES;
        }
        let lut3d = params.output.lut.as_ref().map(|l| {
            flags |= PASS_LUT;
            let d = &l.lut.domain_min;
            let s = l.lut.domain_scale();
            u.lut3d = [(l.lut.size - 1) as f32, l.strength, 0.0, 0.0];
            u.lut3d_min = [d[0], d[1], d[2], 0.0];
            u.lut3d_scale = [s[0], s[1], s[2], 0.0];
            std::sync::Arc::clone(&l.lut)
        });
        u.flags[0] = flags;
        let [w2l, l2w, m2, m2_inv] = oklab_matrices(&matrix::rec2020_to_xyz());
        // The gamut mapper works in the output space (sRGB or Display P3, `params.output.profile`).
        let [o2l, l2o, _, _] = oklab_matrices(&params.output.profile.to_xyz());
        u.work_to_lms = rows(&w2l);
        u.work_from_lms = rows(&l2w);
        u.out_to_lms = rows(&o2l);
        u.out_from_lms = rows(&l2o);
        u.m2 = rows(&m2);
        u.m2_inv = rows(&m2_inv);
        u.to_srgb = rows(&params.output.to_output);
        ChainInputs { uniform: u, luts, curves, lut3d }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::matrix::apply_f32;
    use crate::color::oklab::Oklab;

    fn to_lab(m: &[Mat3f; 4], p: [f32; 3]) -> [f32; 3] {
        let [l, mm, s] = apply_f32(&m[0], p[0], p[1], p[2]);
        apply_f32(&m[2], l.cbrt(), mm.cbrt(), s.cbrt())
    }

    fn to_rgb(m: &[Mat3f; 4], p: [f32; 3]) -> [f32; 3] {
        let [l, mm, s] = apply_f32(&m[3], p[0], p[1], p[2]);
        apply_f32(&m[1], l * l * l, mm * mm * mm, s * s * s)
    }

    /// The matrices the GPU gets are exactly `Oklab`'s (bit-identical conversions).
    #[test]
    fn oklab_matrices_match_the_cpu() {
        for (space, ok) in [
            (matrix::rec2020_to_xyz(), Oklab::new()),
            (matrix::srgb_to_xyz(), Oklab::for_space(&matrix::srgb_to_xyz())),
            (matrix::p3_to_xyz(), Oklab::for_space(&matrix::p3_to_xyz())),
        ] {
            let m = oklab_matrices(&space);
            for p in [[0.2f32, 0.5, 0.9], [1.2, -0.1, 0.05], [0.0, 0.0, 1.0], [0.18, 0.18, 0.18]] {
                assert_eq!(to_lab(&m, p), ok.to_lab(p));
                assert_eq!(to_rgb(&m, p), ok.to_rgb(p));
            }
        }
    }
}
