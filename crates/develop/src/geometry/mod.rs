//! Geometry (D2): orientation, Upright, the manual Transform, straighten and crop as one homography, and the resample into the crop
//! framing. The pipeline warps first, on the linear decoded image; everything else (the cached base,
//! colour, later masks and detail) runs on the warped grid. See `docs/design/archive/DEVELOP_PLAN.md` (section 2
//! "Geometry model", 4.11, Step D2.1).
//!
//! - [`homography`]: the 3×3 type, composition, inverse, DLT.
//! - [`orientation`]: rotate 0/90/180/270 and flips in normalised coordinates.
//! - [`crop`]: inscribed-rectangle formulas and [`crop::constrain_crop`] (mirrored in TypeScript).
//! - [`transform`]: [`GeometryPlan`], the composed map and output size for one `Geometry`; the manual
//!   Transform matrix and the Upright hook (D2.2).
//! - [`upright`]: the guided Upright solver (D2.2) and the shared vanishing-point rotation solve.
//! - [`segments`]: the line-segment detector automatic Upright runs on (D2.3).
//! - [`vanishing`]: per-direction RANSAC vanishing points (D2.3).
//! - [`auto`]: Auto level and automatic Upright (Level, Vertical, Full, Auto) on top of both (D2.3).
//! - [`remap`]: masks and guides re-mapped through `H_new · H_old⁻¹` when the perspective changes.
//! - [`nelder_mead`]: the small minimiser the Upright refinement uses.
//! - [`warp`](mod@warp): exact copies, copy + resize, or Catmull-Rom / Lanczos3 resampling.

pub mod auto;
pub mod crop;
pub mod homography;
pub mod nelder_mead;
pub mod orientation;
pub mod remap;
pub mod segments;
pub mod transform;
pub mod upright;
pub mod vanishing;
pub mod warp;

pub use auto::{analyse, analyse_luma, solve_auto, Analysis, AutoSolution, FocalSource, LevelResult, LevelSource};
pub use crop::{
    constrain_crop, constrain_crop_in_polygon, fixed_aspect_half_width, largest_rect_in_quad, max_area_rect_in_rotated,
    max_crop, max_rect_in_polygon,
};
pub use homography::Homography;
pub use remap::{remap_geometry_vectors, remap_matrix, remap_points};
pub use transform::{
    developed_size, manual_matrix, manual_matrix_with_focal, max_crop_in_warped, perspective_matrix, pre_crop_matrix,
    upright_matrix, GeometryPlan,
};
pub use segments::{analysis_luma, detect_segments, Segment, SegmentOptions};
pub use upright::{
    solve_from_vanishing_points, solve_guided, GuidedCorrection, GuidedSolution, UprightError, WeightedLine,
};
pub use vanishing::{find_vanishing_point, LineClass, VanishingOptions, VanishingPoint};
pub use warp::{warp, warp_with_stats, Quality, WarpPath, WarpStats};
