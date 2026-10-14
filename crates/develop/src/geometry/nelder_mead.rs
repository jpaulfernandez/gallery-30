//! A small deterministic Nelder–Mead minimiser (no dependency), for the Upright refinement.
//!
//! Standard coefficients (reflection 1, expansion 2, contraction ½, shrink ½), an axis-aligned initial
//! simplex of side `step`, and a fixed iteration cap, so the TypeScript twin can transliterate it and
//! land on the same numbers.

/// Iteration cap of [`minimize`].
pub const MAX_ITERATIONS: usize = 600;

/// Minimise `f` from `x0`. Stops when the spread of the simplex's values is below `f_tol` and its
/// diameter below `x_tol`, or after [`MAX_ITERATIONS`]. Returns the best point and its value.
pub fn minimize<const N: usize>(
    f: impl Fn(&[f64; N]) -> f64,
    x0: [f64; N],
    step: f64,
    f_tol: f64,
    x_tol: f64,
) -> ([f64; N], f64) {
    // N + 1 vertices; vertex 0 is x0, vertex i + 1 moves coordinate i by `step`.
    let mut pts: Vec<[f64; N]> = (0..=N)
        .map(|i| {
            let mut p = x0;
            if i > 0 {
                p[i - 1] += step;
            }
            p
        })
        .collect();
    let mut vals: Vec<f64> = pts.iter().map(&f).collect();

    for _ in 0..MAX_ITERATIONS {
        // Sort by value (stable, so ties keep their order).
        let mut order: Vec<usize> = (0..=N).collect();
        order.sort_by(|&a, &b| vals[a].total_cmp(&vals[b]));
        pts = order.iter().map(|&i| pts[i]).collect();
        vals = order.iter().map(|&i| vals[i]).collect();

        let spread = vals[N] - vals[0];
        let diameter = pts[1..]
            .iter()
            .map(|p| p.iter().zip(pts[0].iter()).fold(0.0f64, |m, (a, b)| m.max((a - b).abs())))
            .fold(0.0f64, f64::max);
        if spread <= f_tol && diameter <= x_tol {
            break;
        }

        // Centroid of all but the worst.
        let mut c = [0.0; N];
        for p in &pts[..N] {
            for k in 0..N {
                c[k] += p[k] / N as f64;
            }
        }
        let along = |t: f64| -> [f64; N] { std::array::from_fn(|k| c[k] + t * (pts[N][k] - c[k])) };

        let xr = along(-1.0);
        let fr = f(&xr);
        if fr < vals[0] {
            let xe = along(-2.0);
            let fe = f(&xe);
            if fe < fr {
                pts[N] = xe;
                vals[N] = fe;
            } else {
                pts[N] = xr;
                vals[N] = fr;
            }
            continue;
        }
        if fr < vals[N - 1] {
            pts[N] = xr;
            vals[N] = fr;
            continue;
        }
        // Contraction: outside when the reflection beat the worst, inside otherwise.
        let (xc, fc) = if fr < vals[N] {
            let x = along(-0.5);
            (x, f(&x))
        } else {
            let x = along(0.5);
            (x, f(&x))
        };
        if fc < vals[N].min(fr) {
            pts[N] = xc;
            vals[N] = fc;
            continue;
        }
        // Shrink towards the best vertex.
        for i in 1..=N {
            pts[i] = std::array::from_fn(|k| pts[0][k] + 0.5 * (pts[i][k] - pts[0][k]));
            vals[i] = f(&pts[i]);
        }
    }

    let best = (0..=N).fold(0, |b, i| if vals[i] < vals[b] { i } else { b });
    (pts[best], vals[best])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_rosenbrock_minimum() {
        let rosen = |p: &[f64; 2]| (1.0 - p[0]).powi(2) + 100.0 * (p[1] - p[0] * p[0]).powi(2);
        let (x, v) = minimize(rosen, [-1.2, 1.0], 0.1, 1e-20, 1e-12);
        assert!(v < 1e-10, "{x:?} {v}");
        assert!((x[0] - 1.0).abs() < 1e-4 && (x[1] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn quadratic_in_three_dimensions() {
        let q = |p: &[f64; 3]| (p[0] - 0.3).powi(2) + 2.0 * (p[1] + 0.1).powi(2) + 0.5 * (p[2] - 0.02).powi(2);
        let (x, _) = minimize(q, [0.0; 3], 0.05, 1e-24, 1e-12);
        assert!((x[0] - 0.3).abs() < 1e-8 && (x[1] + 0.1).abs() < 1e-8 && (x[2] - 0.02).abs() < 1e-8);
    }
}
