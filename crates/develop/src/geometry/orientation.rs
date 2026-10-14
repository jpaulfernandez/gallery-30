//! The user's rotate (0/90/180/270, clockwise) and flips, on top of the EXIF orientation that decode
//! already applied.
//!
//! The matrix maps **normalised** coordinates (0..1) of the decoded image to normalised coordinates of
//! the oriented image. Rotation comes first; the flips then act in the rotated frame, i.e. on the image
//! as the user sees it (`flipH` mirrors left/right on screen whatever the rotation).

use super::homography::Homography;
use crate::settings::{Geometry, Rotation};

/// Normalised map for a clockwise rotation (90 and 270 swap the axes; the output size swaps with them).
pub fn rotation_matrix(rotation: Rotation) -> Homography {
    match rotation {
        Rotation::R0 => Homography::identity(),
        // (u, v) → (1 − v, u)
        Rotation::R90 => Homography([0.0, -1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
        // (u, v) → (1 − u, 1 − v)
        Rotation::R180 => Homography([-1.0, 0.0, 1.0, 0.0, -1.0, 1.0, 0.0, 0.0, 1.0]),
        // (u, v) → (v, 1 − u)
        Rotation::R270 => Homography([0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
    }
}

/// Normalised map for the flips: `flip_h` is (u, v) → (1 − u, v), `flip_v` is (u, v) → (u, 1 − v).
pub fn flip_matrix(flip_h: bool, flip_v: bool) -> Homography {
    let (sx, tx) = if flip_h { (-1.0, 1.0) } else { (1.0, 0.0) };
    let (sy, ty) = if flip_v { (-1.0, 1.0) } else { (1.0, 0.0) };
    Homography([sx, 0.0, tx, 0.0, sy, ty, 0.0, 0.0, 1.0])
}

/// `O_orientation`: rotate, then flip.
pub fn orientation_matrix(geometry: &Geometry) -> Homography {
    rotation_matrix(geometry.rotate).then(&flip_matrix(geometry.flip_h, geometry.flip_v))
}

/// Size of the oriented image: `(width, height)` swapped for 90 and 270.
pub fn oriented_size(rotation: Rotation, width: u32, height: u32) -> (u32, u32) {
    match rotation {
        Rotation::R90 | Rotation::R270 => (height, width),
        _ => (width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotations_move_the_top_left_corner_clockwise() {
        let tl = [0.0, 0.0];
        assert_eq!(rotation_matrix(Rotation::R90).apply(tl), [1.0, 0.0]);
        assert_eq!(rotation_matrix(Rotation::R180).apply(tl), [1.0, 1.0]);
        assert_eq!(rotation_matrix(Rotation::R270).apply(tl), [0.0, 1.0]);
        let four = rotation_matrix(Rotation::R90);
        let full = four.then(&four).then(&four).then(&four);
        assert_eq!(full, Homography::identity());
        assert_eq!(rotation_matrix(Rotation::R90).then(&rotation_matrix(Rotation::R270)), Homography::identity());
    }

    #[test]
    fn flips_act_after_rotation() {
        let g = Geometry { rotate: Rotation::R90, flip_h: true, ..Geometry::default() };
        // Top-left → (rotate) top-right → (flip) top-left.
        assert_eq!(orientation_matrix(&g).apply([0.0, 0.0]), [0.0, 0.0]);
        assert_eq!(oriented_size(Rotation::R90, 40, 30), (30, 40));
        assert_eq!(flip_matrix(false, true).apply([0.25, 0.25]), [0.25, 0.75]);
    }
}
