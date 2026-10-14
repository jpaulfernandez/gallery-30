//! Lightroom XMP interop (D6.3): read `crs:` (Camera Raw Settings) sidecars and packets embedded in
//! JPEGs into [`DevelopSettings`], write our own `photobook:` packet (the canonical settings JSON), and a
//! lossy `crs:` export. See `docs/design/archive/DEVELOP_PLAN.md` sections 4.6 and 4.11 and this crate's README
//! ("Lightroom XMP") for the field table, the orientation rules and what is dropped.
//!
//! - [`read_sidecar`], [`read_packet`], [`read_embedded`]: `crs:` → [`XmpImport`].
//! - [`read_photobook_packet`]: our own namespace back to settings.
//! - [`write_photobook_packet`], [`write_crs_packet`], [`merge_into_sidecar`].
//! - [`fields`]: the field tables and the pure orientation remaps ([`remap_crop_for_orientation`], ...).

mod dom;
pub mod fields;
mod read;
mod write;

use serde::Serialize;

use crate::settings::DevelopSettings;

pub use fields::{
    inverse_orientation, orientation_change, orientation_map, remap_crop_for_orientation, remap_transform_sliders,
    remap_upright_transform,
};
pub use read::{find_embedded_packet, read_embedded, read_packet, read_photobook_packet, read_sidecar};
pub use write::{merge_into_sidecar, write_crs_packet, write_photobook_packet, CrsExportOptions};

/// Camera Raw Settings, the namespace Lightroom and Camera Raw write.
pub const NS_CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
pub const NS_TIFF: &str = "http://ns.adobe.com/tiff/1.0/";
pub const NS_EXIF: &str = "http://ns.adobe.com/exif/1.0/";
pub const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
pub const NS_X: &str = "adobe:ns:meta/";
/// Our own namespace: `photobook:Develop` holds the canonical settings JSON, `photobook:Engine` the
/// engine version that rendered them.
pub const NS_PHOTOBOOK: &str = "http://ns.photobook.app/develop/1.0/";

/// The process version [`write_crs_packet`] declares (Lightroom Classic 12.3+ / Camera Raw 15.4).
pub const CRS_PROCESS_VERSION: &str = "15.4";

/// What one `crs:` packet turned into.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmpImport {
    /// The mapped settings (all defaults for a legacy process version).
    pub settings: DevelopSettings,
    /// `crs:ProcessVersion` as written (e.g. `"15.4"`, `"11.0"`, `"5.7"`).
    pub process_version: Option<String>,
    /// Lightroom settings that were in use but did not come across, plus imported items whose Lightroom
    /// meaning is unverified ([`DropKind::Unverified`]).
    pub dropped: Vec<DroppedItem>,
    /// `crs:AlreadyApplied="True"`: the pixels already carry these settings (an exported JPEG). Callers
    /// should skip the import.
    pub already_applied: bool,
    /// `tiff:Orientation` from the packet (1..8), which crop, Upright and Transform were remapped from.
    pub orientation: Option<u8>,
    /// `crs:` fields that were neither mapped nor reported (counted, otherwise ignored). Sorted.
    pub ignored: Vec<String>,
}

/// One entry of [`XmpImport::dropped`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedItem {
    /// The `crs:` field (or group, e.g. `MaskGroupBasedCorrections`).
    pub field: String,
    pub reason: String,
    pub kind: DropKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DropKind {
    /// Not imported.
    Dropped,
    /// Imported, but the Lightroom field's layout or convention is only known from third-party readers.
    Unverified,
}

impl DroppedItem {
    pub(crate) fn dropped(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self { field: field.into(), reason: reason.into(), kind: DropKind::Dropped }
    }

    pub(crate) fn unverified(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self { field: field.into(), reason: reason.into(), kind: DropKind::Unverified }
    }
}
