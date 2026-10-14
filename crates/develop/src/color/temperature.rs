//! Correlated colour temperature and tint ↔ CIE xy by Robertson's (1968) isotemperature-line method, in
//! the form the DNG SDK uses (`dng_temperature`): 31 isotherms in CIE 1960 uv, interpolated in mired,
//! with tint as a displacement along the interpolated isotherm. Tint follows Lightroom's sign and scale:
//! positive is magenta in the rendered image (the illuminant is taken as greener and compensated),
//! 1 unit = 1/3000 uv.

/// `(mired, u, v, slope t)` rows from Wyszecki & Stiles, *Color Science* (2nd ed.), table 1(3.11),
/// with the well-known 325-mired `u` correction (0.24792) the DNG SDK and colour-science also use.
const TABLE: [[f64; 4]; 31] = [
    [0.0, 0.18006, 0.26352, -0.24341],
    [10.0, 0.18066, 0.26589, -0.25479],
    [20.0, 0.18133, 0.26846, -0.26876],
    [30.0, 0.18208, 0.27119, -0.28539],
    [40.0, 0.18293, 0.27407, -0.30470],
    [50.0, 0.18388, 0.27709, -0.32675],
    [60.0, 0.18494, 0.28021, -0.35156],
    [70.0, 0.18611, 0.28342, -0.37915],
    [80.0, 0.18740, 0.28668, -0.40955],
    [90.0, 0.18880, 0.28997, -0.44278],
    [100.0, 0.19032, 0.29326, -0.47888],
    [125.0, 0.19462, 0.30141, -0.58204],
    [150.0, 0.19962, 0.30921, -0.70471],
    [175.0, 0.20525, 0.31647, -0.84901],
    [200.0, 0.21142, 0.32312, -1.0182],
    [225.0, 0.21807, 0.32909, -1.2168],
    [250.0, 0.22511, 0.33439, -1.4512],
    [275.0, 0.23247, 0.33904, -1.7298],
    [300.0, 0.24010, 0.34308, -2.0637],
    [325.0, 0.24792, 0.34655, -2.4681],
    [350.0, 0.25591, 0.34951, -2.9641],
    [375.0, 0.26400, 0.35200, -3.5814],
    [400.0, 0.27218, 0.35407, -4.3633],
    [425.0, 0.28039, 0.35577, -5.3762],
    [450.0, 0.28863, 0.35714, -6.7262],
    [475.0, 0.29685, 0.35823, -8.5955],
    [500.0, 0.30505, 0.35907, -11.324],
    [525.0, 0.31320, 0.35968, -15.628],
    [550.0, 0.32129, 0.36011, -23.325],
    [575.0, 0.32931, 0.36038, -40.770],
    [600.0, 0.33724, 0.36051, -116.45],
];

/// uv units per tint unit (DNG SDK `kTintScale`).
const TINT_SCALE: f64 = -3000.0;

/// CIE xy of the illuminant with correlated colour temperature `kelvin` and `tint`. Temperatures beyond
/// the table (below about 1667 K) extrapolate along its last segment.
pub fn xy_from_temperature(kelvin: f64, tint: f64) -> [f64; 2] {
    let r = 1.0e6 / kelvin;
    let offset = tint / TINT_SCALE;
    let mut index = 0;
    while index < 29 && r >= TABLE[index + 1][0] {
        index += 1;
    }
    let (a, b) = (TABLE[index], TABLE[index + 1]);
    let f = (b[0] - r) / (b[0] - a[0]);
    let mut u = a[1] * f + b[1] * (1.0 - f);
    let mut v = a[2] * f + b[2] * (1.0 - f);
    let (len1, len2) = ((1.0 + a[3] * a[3]).sqrt(), (1.0 + b[3] * b[3]).sqrt());
    let (uu1, vv1) = (1.0 / len1, a[3] / len1);
    let (uu2, vv2) = (1.0 / len2, b[3] / len2);
    let (mut uu3, mut vv3) = (uu1 * f + uu2 * (1.0 - f), vv1 * f + vv2 * (1.0 - f));
    let len3 = (uu3 * uu3 + vv3 * vv3).sqrt();
    uu3 /= len3;
    vv3 /= len3;
    u += uu3 * offset;
    v += vv3 * offset;
    let d = u - 4.0 * v + 2.0;
    [1.5 * u / d, v / d]
}

/// The inverse: `(kelvin, tint)` of a chromaticity.
pub fn temperature_from_xy([x, y]: [f64; 2]) -> (f64, f64) {
    let d = 1.5 - x + 6.0 * y;
    let (u, v) = (2.0 * x / d, 3.0 * y / d);
    let (mut last_dt, mut last_du, mut last_dv) = (0.0, 0.0, 0.0);
    for index in 1..=30 {
        let len = (1.0 + TABLE[index][3] * TABLE[index][3]).sqrt();
        let (mut du, mut dv) = (1.0 / len, TABLE[index][3] / len);
        let (uu, vv) = (u - TABLE[index][1], v - TABLE[index][2]);
        let mut dt = -uu * dv + vv * du;
        if dt <= 0.0 || index == 30 {
            dt = -dt.min(0.0);
            let f = if index == 1 { 0.0 } else { dt / (last_dt + dt) };
            let (a, b) = (TABLE[index - 1], TABLE[index]);
            let kelvin = 1.0e6 / (a[0] * f + b[0] * (1.0 - f));
            let uu = u - (a[1] * f + b[1] * (1.0 - f));
            let vv = v - (a[2] * f + b[2] * (1.0 - f));
            du = du * (1.0 - f) + last_du * f;
            dv = dv * (1.0 - f) + last_dv * f;
            let len = (du * du + dv * dv).sqrt();
            let tint = (uu * du / len + vv * dv / len) * TINT_SCALE;
            return (kelvin, tint);
        }
        last_dt = dt;
        last_du = du;
        last_dv = dv;
    }
    unreachable!("the loop returns at index 30")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::matrix::{D50_XY, D65_XY};

    #[test]
    fn round_trip_6500() {
        let xy = xy_from_temperature(6500.0, 0.0);
        let (k, tint) = temperature_from_xy(xy);
        assert!((k - 6500.0).abs() < 3.0, "{k}");
        assert!(tint.abs() < 0.1, "{tint}");
        for (kelvin, tint) in [(2000.0, -40.0), (3200.0, 10.0), (5000.0, 25.0), (12000.0, -100.0), (30000.0, 150.0)] {
            let (k, t) = temperature_from_xy(xy_from_temperature(kelvin, tint));
            assert!((k - kelvin).abs() / kelvin < 0.002, "{kelvin}: {k}");
            assert!((t - tint).abs() < 0.5, "{tint}: {t}");
        }
    }

    #[test]
    fn standard_illuminants() {
        // CIE published CCTs: D65 ≈ 6504 K, D50 ≈ 5003 K, illuminant A = 2856 K.
        let (k, tint) = temperature_from_xy(D65_XY);
        assert!((k - 6504.0).abs() < 5.0, "D65 {k}");
        assert!(tint > 0.0 && tint < 15.0, "D65 tint {tint}");
        let (k, _) = temperature_from_xy(D50_XY);
        assert!((k - 5003.0).abs() < 5.0, "D50 {k}");
        let (k, _) = temperature_from_xy([0.44757, 0.40745]);
        assert!((k - 2856.0).abs() < 5.0, "A {k}");
    }

    #[test]
    fn positive_tint_is_greener_illuminant() {
        // CIE 1960 v grows towards green.
        let [x0, y0] = xy_from_temperature(5000.0, 0.0);
        let [x1, y1] = xy_from_temperature(5000.0, 50.0);
        let v = |x: f64, y: f64| 3.0 * y / (1.5 - x + 6.0 * y);
        assert!(v(x1, y1) > v(x0, y0));
    }
}
