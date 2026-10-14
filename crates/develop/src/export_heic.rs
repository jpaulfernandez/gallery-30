//! HEIC export through ImageIO (workflow plan 12; macOS, feature `heic-imageio`).
//!
//! The 16-bit frame becomes a 16-bit-per-component `CGImage` tagged with the output profile's colour space
//! (`kCGColorSpaceSRGB` or `kCGColorSpaceDisplayP3`); ImageIO writes it as a 10-bit HEVC HEIC with that profile in a
//! `colr` box. The Exif the preset asks for goes in through the destination's properties dictionary: *all* copies the
//! source's TIFF, Exif, GPS and IPTC dictionaries as ImageIO reads them (any format it reads, RAW included) with the
//! orientation reset to 1; *copyright* writes only Copyright and Artist (read with `kamadak-exif`, as for JPEG).

use std::ffi::c_void;
use std::path::Path;

use objc2_core_foundation::{CFData, CFDictionary, CFMutableData, CFMutableDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    kCGColorSpaceDisplayP3, kCGColorSpaceSRGB, CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage,
    CGImageAlphaInfo, CGImageByteOrderInfo,
};
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary,
    kCGImagePropertyIPTCDictionary, kCGImagePropertyOrientation, kCGImagePropertyTIFFArtist, kCGImagePropertyTIFFCopyright,
    kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFOrientation, CGImageDestination, CGImageSource,
};

use crate::color::OutputProfile;
use crate::error::{Error, Result};
use crate::export::ExportMetadata;
use crate::image::Rgb16Image;

/// A HEIC (10-bit HEVC) of `image` at `quality` (1..100), tagged with `profile`, with the Exif `metadata` asks for
/// from `exif_source`.
pub fn encode_heic(
    image: &Rgb16Image,
    quality: u8,
    profile: OutputProfile,
    metadata: ExportMetadata,
    exif_source: Option<&Path>,
) -> Result<Vec<u8>> {
    let (w, h) = (image.width as usize, image.height as usize);
    let bytes: Vec<u8> = image.data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let data = CFData::from_bytes(&bytes);
    drop(bytes);
    let provider = CGDataProvider::with_cf_data(Some(&data)).ok_or_else(|| Error::Invalid("CoreGraphics refused the pixels".into()))?;
    let name: &CFString = unsafe {
        match profile {
            OutputProfile::Srgb => kCGColorSpaceSRGB,
            OutputProfile::DisplayP3 => kCGColorSpaceDisplayP3,
        }
    };
    let space = CGColorSpace::with_name(Some(name)).ok_or_else(|| Error::Invalid("no output colour space".into()))?;
    let info = CGBitmapInfo(CGImageAlphaInfo::None.0 | CGImageByteOrderInfo::Order16Little.0);
    // SAFETY: `provider` holds `h` rows of `w * 6` bytes; no decode array.
    let cg = unsafe {
        CGImage::new(
            w,
            h,
            16,
            48,
            w * 6,
            Some(&space),
            info,
            Some(&provider),
            std::ptr::null(),
            false,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
    .ok_or_else(|| Error::Invalid("CoreGraphics refused a 16-bit image".into()))?;

    let props = CFMutableDictionary::<CFString, CFType>::empty();
    let q = CFNumber::new_f64(quality.clamp(1, 100) as f64 / 100.0);
    props.set(unsafe { kCGImageDestinationLossyCompressionQuality }, q.as_ref());
    let one = CFNumber::new_i32(1);
    props.set(unsafe { kCGImagePropertyOrientation }, one.as_ref());
    if let Some(src) = exif_source {
        match metadata {
            ExportMetadata::All => copy_source_metadata(src, &props),
            ExportMetadata::Copyright => {
                let tiff = CFMutableDictionary::<CFString, CFType>::empty();
                let (copyright, artist) = crate::export::copyright_strings(src);
                let mut any = false;
                for (key, value) in [(unsafe { kCGImagePropertyTIFFCopyright }, copyright), (unsafe { kCGImagePropertyTIFFArtist }, artist)] {
                    if let Some(value) = value {
                        tiff.set(key, CFString::from_str(&value).as_ref());
                        any = true;
                    }
                }
                if any {
                    props.set(unsafe { kCGImagePropertyTIFFDictionary }, tiff.as_ref());
                }
            }
            ExportMetadata::None => {}
        }
    }

    let out = CFMutableData::new(None, 0).ok_or_else(|| Error::Invalid("no memory for the HEIC".into()))?;
    let uti = CFString::from_str("public.heic");
    // SAFETY: a mutable data destination for one image; the dictionaries hold CF keys and values.
    let dest = unsafe { CGImageDestination::with_data(&out, &uti, 1, None) }
        .ok_or_else(|| Error::Unsupported("this system cannot write HEIC".into()))?;
    unsafe { dest.add_image(&cg, Some(props.as_opaque())) };
    if !unsafe { dest.finalize() } {
        return Err(Error::Invalid("ImageIO could not write the HEIC".into()));
    }
    drop(dest);
    Ok(out.to_vec())
}

/// The value of `key` in an untyped CF dictionary, borrowed from it.
fn value<'a>(dict: &'a CFDictionary, key: &CFString) -> Option<&'a CFType> {
    // SAFETY: a CFString key in a dictionary of CF objects; the value (if any) is borrowed from `dict`.
    let ptr = unsafe { dict.value((key as *const CFString).cast::<c_void>()) };
    (!ptr.is_null()).then(|| unsafe { &*ptr.cast::<CFType>() })
}

/// The TIFF, Exif, GPS and IPTC dictionaries of `src` as ImageIO reads them, into `props`, the TIFF orientation set
/// to 1 (the pixels are upright). Nothing when ImageIO cannot read the file.
fn copy_source_metadata(src: &Path, props: &CFMutableDictionary<CFString, CFType>) {
    let Ok(bytes) = std::fs::read(src) else { return };
    let data = CFData::from_bytes(&bytes);
    // SAFETY: no options dictionary.
    let Some(source) = (unsafe { CGImageSource::with_data(&data, None) }) else { return };
    // SAFETY: index 0 with no options.
    let Some(meta) = (unsafe { source.properties_at_index(0, None) }) else { return };
    for key in unsafe { [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyIPTCDictionary] } {
        if let Some(v) = value(&meta, key) {
            props.set(key, v);
        }
    }
    let tiff_key = unsafe { kCGImagePropertyTIFFDictionary };
    if let Some(tiff) = value(&meta, tiff_key).and_then(|v| v.downcast_ref::<CFDictionary>()) {
        // SAFETY: a mutable copy of a CF dictionary of CF objects.
        if let Some(copy) = unsafe { CFMutableDictionary::new_copy(None, 0, Some(tiff)) } {
            let one = CFNumber::new_i32(1);
            // SAFETY: CF key and value.
            unsafe {
                CFMutableDictionary::set_value(
                    Some(&copy),
                    (kCGImagePropertyTIFFOrientation as *const CFString).cast(),
                    (&*one as *const CFNumber).cast(),
                )
            };
            let copy: &CFDictionary = &copy;
            props.set(tiff_key, copy.as_ref());
        }
    }
}

/// What ImageIO reads back from an encoded file: size, bits per component and colour space name (tests).
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub width: usize,
    pub height: usize,
    pub bits: usize,
    pub space: Option<String>,
}

/// Decode `bytes` (any format ImageIO reads: HEIC, AVIF on macOS 13 and later, TIFF) and describe the image.
pub fn probe(bytes: &[u8]) -> Option<Probe> {
    let data = CFData::from_bytes(bytes);
    let source = unsafe { CGImageSource::with_data(&data, None) }?;
    let image: CFRetained<CGImage> = unsafe { source.image_at_index(0, None) }?;
    let space = CGImage::color_space(Some(&image));
    let name = space.as_deref().and_then(|s| CGColorSpace::name(Some(s))).map(|n| n.to_string());
    Some(Probe {
        width: CGImage::width(Some(&image)),
        height: CGImage::height(Some(&image)),
        bits: CGImage::bits_per_component(Some(&image)),
        space: name,
    })
}
