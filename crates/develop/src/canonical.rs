//! Port of `canonicalJson` in `packages/shared/src/publish/canonical.ts`: object keys sorted at every
//! level (by UTF-16 code unit, like JS string comparison), arrays in order, strings escaped and numbers
//! written exactly as `JSON.stringify` does. The output is byte-identical to the TypeScript function for
//! any JSON value, which is what lets both sides compute the same `developHash`.

use serde_json::Value;

/// Stable JSON for `value`; see the module docs.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                // i64 and u64 below 2^63; JS writes integers up to 1e21 in full, but past 2^53 a JS number
                // would already have lost precision, so settings never hold such integers.
                out.push_str(&js_number(i as f64).unwrap_or_else(|| i.to_string()));
            } else if let Some(u) = n.as_u64() {
                out.push_str(&js_number(u as f64).unwrap_or_else(|| u.to_string()));
            } else {
                // `as_f64` is always Some without serde_json's `arbitrary_precision` feature.
                match n.as_f64().and_then(js_number) {
                    Some(s) => out.push_str(&s),
                    None => out.push_str("null"),
                }
            }
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

/// serde_json escapes exactly like `JSON.stringify` for valid Unicode (`"`, `\`, `\b \f \n \r \t`, other
/// control characters as lowercase `\u00xx`, everything else verbatim). Rust strings cannot hold the lone
/// surrogates where the two could differ.
fn write_string(out: &mut String, s: &str) {
    out.push_str(&serde_json::to_string(s).expect("strings always serialise"));
}

/// `Number.prototype.toString()` for a finite `f64` (ECMA-262 Number::toString with radix 10), `None` for
/// NaN and infinities (which `JSON.stringify` writes as `null`).
///
/// The number of digits comes from Rust's `{:e}` formatting, which, like JS, picks the shortest digit
/// string that reads back as the same double. When two such strings are equally close to the double
/// (an exact tie, e.g. `1063639691336433.25` or `1 + 2^-17`), JS takes the even one but `{:e}` may not, so
/// the digits are re-derived with `{:.prec$e}`, which rounds the exact value half to even. The
/// layout rules are the spec's: plain digits for exponents up to 21, `0.000ddd` down to 1e-6, otherwise
/// `d.ddde+n` / `d.ddde-n`. `-0` is written as `0`. So `1.0` gives `1`, `1e21` gives `1e+21`, `1e-7`
/// gives `1e-7` and `0.000001` gives `0.000001`, as in JS.
pub fn js_number(x: f64) -> Option<String> {
    if !x.is_finite() {
        return None;
    }
    if x == 0.0 {
        return Some("0".to_string());
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let mut sci = format!("{:e}", x.abs()); // e.g. "1.2345e3", "1e-7"
    let shortest_len = sci.split_once('e').map_or(0, |(m, _)| m.chars().filter(|c| *c != '.').count());
    // Same length, closest to the exact value with ties to even: what ECMA-262 Number::toString picks.
    let even = format!("{:.*e}", shortest_len.saturating_sub(1), x.abs());
    if even != sci && even.parse::<f64>() == Ok(x.abs()) {
        sci = even;
    }
    let (mantissa, exp) = sci.split_once('e').expect("{:e} always has an exponent");
    let exp: i32 = exp.parse().expect("{:e} exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = match digits.trim_end_matches('0') {
        "" => "0".to_string(),
        trimmed => trimmed.to_string(),
    };
    let k = digits.len() as i32;
    let n = exp + 1; // value = 0.d1d2...dk × 10^n
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    Some(format!("{sign}{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_match_js() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (100.0, "100"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1.0 / 3.0, "0.3333333333333333"),
            (-1234.5678, "-1234.5678"),
            (0.000001, "0.000001"),
            (0.0000012, "0.0000012"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (2.5e-300, "2.5e-300"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (9007199254740993.0, "9007199254740992"),
            // Exact ties between two shortest candidates: JS takes the even digit.
            (1063639691336433.25, "1063639691336433.2"),
            (1.00000762939453125, "1.0000076293945312"),
            (-1.00000762939453125, "-1.0000076293945312"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number(*x).as_deref(), Some(*want), "{x:e}");
        }
        assert_eq!(js_number(f64::NAN), None);
        assert_eq!(js_number(f64::INFINITY), None);
    }

    #[test]
    fn sorts_keys_and_keeps_arrays() {
        let v = json!({ "b": [3, 1.0, { "z": null, "a": "x\"y\n" }], "a": true, "B": 1.5 });
        assert_eq!(canonical_json(&v), r#"{"B":1.5,"a":true,"b":[3,1,{"a":"x\"y\n","z":null}]}"#);
    }

    #[test]
    fn sorts_keys_by_utf16_code_unit() {
        // U+FF5E sorts after U+1F600 in UTF-8 byte order but before it in UTF-16 (JS) order.
        let v = json!({ "\u{1F600}": 1, "\u{FF5E}": 2 });
        assert_eq!(canonical_json(&v), "{\"\u{1F600}\":1,\"\u{FF5E}\":2}");
    }
}
