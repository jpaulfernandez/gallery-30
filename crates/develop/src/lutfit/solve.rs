//! The least-squares LUT solve (workflow plan 22): every pixel pair is one equation `Σ wₖ·xₖ = y` over the four
//! lattice points of its tetrahedron (the same weights [`crate::lut::Lut3d::apply`] interpolates with, so the fitted
//! lattice reproduces the pairs through the render's own interpolation), plus a smoothness term (squared second
//! differences along each axis, a discrete Laplacian that is zero on affine maps, so lattice points no pixel reaches
//! continue the fitted trend) and a faint pull towards the identity that keeps the system positive definite. The
//! normal equations are banded (a point only meets the 26 points around it), so they are kept as 27 coefficients
//! per point and solved by Jacobi-preconditioned conjugate gradients, the three channels in lockstep.

use rayon::prelude::*;

use crate::error::{Error, Result};

/// The pull towards the identity, relative to the data (an average lattice point carries a data weight of 1).
const IDENTITY_PULL: f64 = 1e-4;
const MAX_ITERATIONS: usize = 600;
/// Relative residual at which the solve stops.
const TOLERANCE: f64 = 1e-7;

/// The four lattice points (coordinates) and weights of `rgb`'s tetrahedron on an `n³` lattice over 0..1. The same
/// arithmetic as [`crate::lut::Lut3d::apply`].
#[inline]
pub(crate) fn tetra(rgb: [f32; 3], n: usize) -> ([[usize; 3]; 4], [f32; 4]) {
    let last = (n - 1) as f32;
    let mut i = [0usize; 3];
    let mut f = [0.0f32; 3];
    for c in 0..3 {
        let t = rgb[c].clamp(0.0, 1.0) * last;
        let k = t.floor().min(last - 1.0);
        i[c] = k as usize;
        f[c] = t - k;
    }
    let [r, g, b] = i;
    let [fr, fg, fb] = f;
    let (c1, c2, w) = if fr >= fg {
        if fg >= fb {
            ([r + 1, g, b], [r + 1, g + 1, b], [1.0 - fr, fr - fg, fg - fb, fb])
        } else if fr >= fb {
            ([r + 1, g, b], [r + 1, g, b + 1], [1.0 - fr, fr - fb, fb - fg, fg])
        } else {
            ([r, g, b + 1], [r + 1, g, b + 1], [1.0 - fb, fb - fr, fr - fg, fg])
        }
    } else if fb >= fg {
        ([r, g, b + 1], [r, g + 1, b + 1], [1.0 - fb, fb - fg, fg - fr, fr])
    } else if fb >= fr {
        ([r, g + 1, b], [r, g + 1, b + 1], [1.0 - fg, fg - fb, fb - fr, fr])
    } else {
        ([r, g + 1, b], [r + 1, g + 1, b], [1.0 - fg, fg - fr, fr - fb, fb])
    };
    ([[r, g, b], c1, c2, [r + 1, g + 1, b + 1]], w)
}

/// The normal equations of the data term: `AᵀA` as 27 coefficients per lattice point (offsets −1..1 per axis,
/// red fastest) and `Aᵀy` per channel.
pub(crate) struct Normal {
    pub n: usize,
    pub ata: Vec<[f64; 27]>,
    pub aty: Vec<[f64; 3]>,
    pub total: f64,
}

impl Normal {
    pub fn new(n: usize) -> Normal {
        let len = n * n * n;
        Normal { n, ata: vec![[0.0; 27]; len], aty: vec![[0.0; 3]; len], total: 0.0 }
    }

    #[inline]
    fn index(&self, c: [usize; 3]) -> usize {
        (c[2] * self.n + c[1]) * self.n + c[0]
    }

    /// Add the pair `src → dst` with `weight`.
    pub fn add(&mut self, src: [f32; 3], dst: [f32; 3], weight: f64) {
        let (corners, w) = tetra(src, self.n);
        for a in 0..4 {
            if w[a] == 0.0 {
                continue;
            }
            let ia = self.index(corners[a]);
            let wa = weight * w[a] as f64;
            for b in 0..4 {
                if w[b] == 0.0 {
                    continue;
                }
                let d = |c: usize| (corners[b][c] + 1 - corners[a][c]) as usize;
                self.ata[ia][d(0) + 3 * d(1) + 9 * d(2)] += wa * w[b] as f64;
            }
            for c in 0..3 {
                self.aty[ia][c] += wa * dst[c] as f64;
            }
        }
        self.total += weight;
    }

    /// The share of lattice points some pixel pair reaches (with a weight above a hundredth of an average point's).
    pub fn coverage(&self) -> f32 {
        let len = self.ata.len();
        if self.total <= 0.0 {
            return 0.0;
        }
        let floor = 0.01 * self.total / len as f64;
        self.ata.iter().filter(|row| row[13] > floor).count() as f32 / len as f32
    }
}

/// `out = λ·DᵀD·x` for the second differences along each axis.
fn add_smoothness(n: usize, x: &[[f64; 3]], lambda: f64, out: &mut [[f64; 3]]) {
    if n < 3 || lambda == 0.0 {
        return;
    }
    let strides = [1, n, n * n];
    for (axis, &stride) in strides.iter().enumerate() {
        for k in 0..x.len() {
            let coord = (k / strides[axis]) % n;
            if coord == 0 || coord == n - 1 {
                continue;
            }
            let (a, b) = (k - stride, k + stride);
            for c in 0..3 {
                let r = lambda * (x[a][c] - 2.0 * x[k][c] + x[b][c]);
                out[a][c] += r;
                out[k][c] -= 2.0 * r;
                out[b][c] += r;
            }
        }
    }
}

/// The diagonal of `DᵀD` at lattice coordinate `i` along one axis of `n`: 4 as a middle point, 1 per triple it ends.
fn smoothness_diagonal(i: usize, n: usize) -> f64 {
    if n < 3 {
        return 0.0;
    }
    let middle = (i > 0 && i < n - 1) as u32 as f64;
    let ends = (i >= 2) as u32 as f64 + (i + 2 < n) as u32 as f64;
    4.0 * middle + ends
}

/// A solved lattice and how well the solve converged.
pub(crate) struct Solved {
    /// `n³` entries in `.cube` order, clamped to 0..1.
    pub data: Vec<[f32; 3]>,
    /// Final relative residual `‖b − Ax‖ / ‖b‖`, the worst channel.
    pub residual: f64,
    pub converged: bool,
    pub iterations: usize,
}

/// Solve for the `n³` lattice (`.cube` order) from `normal`, starting from `start` (the identity when `None`).
/// `smoothness` is the Laplacian weight relative to the data. `cancelled` is polled before the first iteration (so
/// at least once per solve) and every few after; `progress` gets the fraction done.
pub(crate) fn solve(
    normal: &Normal,
    smoothness: f64,
    start: Option<&[[f32; 3]]>,
    cancelled: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(f32),
) -> Result<Solved> {
    let n = normal.n;
    let len = n * n * n;
    if normal.total <= 0.0 {
        return Err(Error::Invalid("No pixel pairs to fit".into()));
    }
    // An average lattice point carries a data weight of 1.
    let scale = len as f64 / normal.total;
    let identity: Vec<[f64; 3]> = (0..len)
        .map(|k| {
            let step = 1.0 / (n - 1) as f64;
            [(k % n) as f64 * step, ((k / n) % n) as f64 * step, (k / (n * n)) as f64 * step]
        })
        .collect();
    let deltas: [isize; 27] = std::array::from_fn(|o| {
        let d = |v: usize| v as isize - 1;
        d(o % 3) + d((o / 3) % 3) * n as isize + d(o / 9) * (n * n) as isize
    });
    let apply = |x: &[[f64; 3]], out: &mut [[f64; 3]]| {
        out.par_iter_mut().enumerate().for_each(|(k, o)| {
            let row = &normal.ata[k];
            let mut acc = [0.0f64; 3];
            for (off, &a) in row.iter().enumerate() {
                if a != 0.0 {
                    let j = (k as isize + deltas[off]) as usize;
                    for c in 0..3 {
                        acc[c] += a * x[j][c];
                    }
                }
            }
            for c in 0..3 {
                o[c] = scale * acc[c] + IDENTITY_PULL * x[k][c];
            }
        });
        add_smoothness(n, x, smoothness, out);
    };
    let diag: Vec<f64> = (0..len)
        .map(|k| {
            let s = smoothness_diagonal(k % n, n) + smoothness_diagonal((k / n) % n, n) + smoothness_diagonal(k / (n * n), n);
            scale * normal.ata[k][13] + smoothness * s + IDENTITY_PULL
        })
        .collect();
    let b: Vec<[f64; 3]> = (0..len)
        .map(|k| std::array::from_fn(|c| scale * normal.aty[k][c] + IDENTITY_PULL * identity[k][c]))
        .collect();
    let mut x: Vec<[f64; 3]> = match start {
        Some(s) if s.len() == len => s.iter().map(|v| v.map(f64::from)).collect(),
        _ => identity.clone(),
    };
    let dot = |a: &[[f64; 3]], b: &[[f64; 3]]| -> [f64; 3] {
        a.par_iter().zip(b.par_iter()).map(|(p, q)| [p[0] * q[0], p[1] * q[1], p[2] * q[2]]).reduce(
            || [0.0; 3],
            |u, v| [u[0] + v[0], u[1] + v[1], u[2] + v[2]],
        )
    };
    let mut ax = vec![[0.0f64; 3]; len];
    apply(&x, &mut ax);
    let mut r: Vec<[f64; 3]> = b.iter().zip(&ax).map(|(p, q)| [p[0] - q[0], p[1] - q[1], p[2] - q[2]]).collect();
    let precondition = |r: &[[f64; 3]]| -> Vec<[f64; 3]> { r.iter().zip(&diag).map(|(v, d)| v.map(|e| e / d)).collect() };
    let mut z = precondition(&r);
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    let bb = dot(&b, &b);
    let mut ap = vec![[0.0f64; 3]; len];
    let relative = |rr: [f64; 3]| (0..3).map(|c| (rr[c] / bb[c].max(1e-30)).sqrt()).fold(0.0, f64::max);
    let mut iterations = 0;
    let mut residual = relative(dot(&r, &r));
    for iteration in 0..MAX_ITERATIONS {
        if iteration % 8 == 0 {
            if cancelled() {
                return Err(Error::Invalid(super::CANCELLED.into()));
            }
            progress(iteration as f32 / MAX_ITERATIONS as f32);
        }
        residual = relative(dot(&r, &r));
        if residual <= TOLERANCE {
            break;
        }
        iterations = iteration + 1;
        apply(&p, &mut ap);
        let pap = dot(&p, &ap);
        let alpha: [f64; 3] = std::array::from_fn(|c| if pap[c] > 1e-300 { rz[c] / pap[c] } else { 0.0 });
        x.par_iter_mut().zip(r.par_iter_mut()).zip(p.par_iter().zip(ap.par_iter())).for_each(|((xk, rk), (pk, apk))| {
            for c in 0..3 {
                xk[c] += alpha[c] * pk[c];
                rk[c] -= alpha[c] * apk[c];
            }
        });
        z = precondition(&r);
        let rz_next = dot(&r, &z);
        let beta: [f64; 3] = std::array::from_fn(|c| if rz[c] > 1e-300 { rz_next[c] / rz[c] } else { 0.0 });
        rz = rz_next;
        p.par_iter_mut().zip(z.par_iter()).for_each(|(pk, zk)| {
            for c in 0..3 {
                pk[c] = zk[c] + beta[c] * pk[c];
            }
        });
    }
    if iterations == MAX_ITERATIONS {
        residual = relative(dot(&r, &r));
    }
    progress(1.0);
    Ok(Solved {
        data: x.into_iter().map(|v| v.map(|e| e.clamp(0.0, 1.0) as f32)).collect(),
        residual,
        converged: residual <= TOLERANCE,
        iterations,
    })
}
